# 01 — Riverside teardown + "capture local, deliver later" reference architectures

> Scope: reverse-engineer Riverside.fm's local recording / upload reliability, compare with
> Zoom, Descript, StreamYard, Otter, Loom, Granola/Fireflies, and open-source recorders, then
> extract the reusable client state machine and persisted metadata for Walfly's additive
> fallback (tee every 100 ms PCM frame to disk while the WS stream runs; deliver later).
> Companion notes: 02 (web OPFS buffer), 03 (native buffer), 04 (recovery API).
> Vocabulary follows `streaming-plan.md` §3/§6 and `apps/mobile/lib/streamClient.ts`.

Everything marked **[observed]** comes from Riverside's public production JS bundles
(StudioLive MFE `0.1791.1` and `web_uploader` MFE `0.23.0`, fetched 2026-10-14 via their
public `mf-manifest.json`): real names read out of shipped code, but behavior may be
feature-flagged or dead. §1.1 marked **documented** is quoted from help-center/marketing pages;
interpretations (e.g. what "acceleratedEndpoint" implies) are called out as inference.

---

## TL;DR

| Tool | Local storage | When upload happens | Resume model | Recovery UX |
|---|---|---|---|---|
| **Riverside.fm** | Browser temporary storage — **[observed]** OPFS `ClientRecordings/V2/<isolationId>/<takeId>/<streamId>/<slug>/<label>/…` + IndexedDB metadata; native apps use app storage | During the session (parts stream continuously; sidebar shows %); finishes after stop | Part-level S3 multipart with persisted cursors; pauses offline, resumes online; retries 2/4/8/16/30 s; multi-tab master election; `/upload` or app relaunch rescans local storage | Reopen `riverside.com/upload` or app; partial track editable 30 min after stop; cloud recording backup; **same computer+browser**; local files deleted after upload |
| **Zoom** | Local disk (`.zoom` raw → `zoom_0.mp4` / `audio_only.m4a`) | Never during; conversion at stop | None | Manual re-trigger of conversion; corrupt files common; support-mediated |
| **Descript** | Browser storage for web ("primary recordings … stored in your browser"); app storage on desktop | After stop; Rooms via rejoin | Rejoin / recovery page / link, **7 days**; same browser or app required | `/recovery` progress page, partials kept, per-participant low-quality **backups**, partial→full replacement |
| **StreamYard** | Browser local storage while in studio | During and after broadcast | `streamyard.com/upload`, same browser+device, **30 days** | "Stuck upload" playbook; host can download partials; full upload re-processed automatically |
| **Otter.ai** | Device-local cache while offline | Live when online; else after reconnect | Reopen app/browser on the recording device; upload resumes | Shows "Live/incomplete"; transcript updates on reconnect; force-quit can strand audio |
| **Loom** | Desktop temp files (third-party claim); no guaranteed browser-local copy | After stop (cloud-first) | Keep tab open ≥30 min; desktop recovery page | Crash/stuck → contact support; weakest recovery story in the set |
| **Granola / Fireflies (bot-free)** | Mic + system audio captured locally | Live/after stop | — | **Neither persists audio** ("does not record or save audio", "does not save audio or video files") — transcript only |
| **Open source** | RecordRTC `DiskStorage`→IndexedDB; modern recorders→OPFS; tus/resumable.js for transport | Configurable | tus `Upload-Offset`; resumable.js per-chunk retry | Varies; Recordly issue #1128 = "save instead of discard on unexpected close" |

---

## 1. Riverside deep dive

### 1.1 What is documented

- **Local-first capture, per-track**: up to 4K video and "uncompressed 48kHz WAV audio" per
  participant ([FAQ](https://riverside.fm/faq)).
- **Uploads run *during* the session, in real time**: "As the session progresses, Riverside uploads
  everything to the cloud in the background, in real-time" ([FAQ](https://riverside.fm/faq));
  hosts watch per-participant upload % in the sidebar "throughout the call", and participants
  keep the window/app open until **Successfully uploaded**
  ([status guide](https://support.riverside.com/hc/en-us/articles/5457425335965)).
- **Storage is browser temporary storage, profile-bound.** Tracks live "in your browser's
  temporary storage before uploading" and are erased after upload
  ([pending uploads](https://support.riverside.com/hc/en-us/articles/5458227676957)); recovery
  requires "the same computer, browser, and browser profile you used to record"
  ([stuck uploads](https://support.riverside.com/hc/en-us/articles/19135749320093)).
- **Recovery surfaces**: `riverside.com/upload` resumes pending tracks ("Your track data should
  begin uploading automatically"), which "continue to upload even if your computer is in sleep
  mode" ([finish uploading](https://support.riverside.com/hc/en-us/articles/5456562719517));
  on mobile, relaunch and keep the app open ([close app](https://support.riverside.com/hc/en-us/articles/5592736661661))
  — but **mobile cannot record without internet at all**
  ([offline mobile](https://support.riverside.com/hc/en-us/articles/19680664067997)).
- **Track lifecycle**: Recording → Uploading → Processing → Ready (+ Error / "Couldn't be
  processed"). A guest who left early yields a **partial high-quality track** that starts
  uploading/processing automatically 15 minutes after the call, editable after 30; missing spans
  render black/silent and are omitted from the transcript. A lower-quality live-encoded **cloud
  recording** is the immediate fallback
  ([partial track](https://support.riverside.com/hc/en-us/articles/19508681766557)).
- **Crash claim** ([FAQ](https://riverside.fm/faq)): "Riverside can withstand browser crashes" —
  mechanism never documented.

### 1.2 What the shipped code shows [observed]

Sources: `https://riverside.com/builds/mfe/StudioLive/0.1791.1/mf-manifest.json` and its chunks
(notably `static/js/async/62.d6a85b59.js`), plus `web_uploader/0.23.0`'s exposed `UploadService`
chunk. The recording engine is a **dedicated Web Worker** ("`serviceUploader`", created from a
Blob that `importScripts()` a compiled worker URL), so storage and upload never touch the UI
thread.

- **Storage choices are feature flags, OPFS by default**: `localFilesType ?? "opfs"`,
  `muxer ?? "libav"`, `separateTracks: true`, `awsSdkV3: true`, `mediaRecorderClock: "samples"`,
  plus `webcodecsRecorder` and frame-size flags. Encoders are `Native` vs `Libav` (libav.js/WASM);
  WebCodecs adds `VideoEncoder`/`AudioEncoder` paths. OPFS layout is literal:
  `ClientRecordings/V2/<isolationId>/<takeId>/<streamId>/<slug>/<label>/<part>`, with
  `isolationId = takeId :: streamId :: slug :: label :: connectionId`. Part suffixes: `rspart3`
  (video, legacy `rspart4`), `rsaudpc`, `mp3`, `raw`; `maxPartDuration` rotates parts.
- **IndexedDB is metadata, not audio**: recording↔server-id mapping ("`Failed to persist
  recordingServerId to IndexedDB`"), device stores, libav's `emscripten_filesystem`/`FILES` IDB;
  an `indexDB` issue type surfaces IDB failures to users.
- **Multipart S3 upload with an accelerated side channel**: `GET /api/config` → `awsConfig` (SDK
  v3); events `uploadPartFinished`/`uploadPartFailed`; targets
  `acceleratedEndpoint | direct | proxy`. "Accelerated" exposes a data-channel uploader
  (`DCpartUploaded`/`DCpartFailed`/`DCbufferedAmountLow`) with pacing telemetry
  (`outgoingBitrate`, `chunkSize`, `queueTrend`, `congestedTicks`, `dataChannelBufferedBytes`) —
  inference: parts ride the live call's SCTP channel while REST ("restUploader") is the fallback;
  `parallelUploading` is a knob.
- **Recovery machinery** (most copyable):
  - `recoverUploads()` rescans the local hybrid queue via
    `{event:"recoverUploads", baseUrl, forceRecover}` (1 s retry, `alreadyRecover` guard);
    `emptyHybridQueueWhenStorageEmpty` / `returnFailedHybridPartToUploadQueue` govern cleanup.
  - `offline` → pause, `online` → resume; retry ladder 2/4/8/16/30 s.
  - **Multi-tab single uploader**: tab ids in `localStorage["uploadtabs"]`; master uploads,
    slaves call `pauseUploading("another tab already upload")`; `pagehide` → next tab becomes
    master (`forceRecover`, `masterGracePeriodMs` = 500 ms) — their duplicate-upload defense.
  - Server sync: `PATCH /api/v4/recording/update/{archiveId}` with
    `status/clientStatus: "uploading"|"idle"`, `type:"local"`.
- **Enumerated states and errors**: per-archive `idle → uploading → uploaded → done`; recorder
  errors include `quotaExceeded, storeError, DataBaseStoreError, MediaRecorderError, streamEnded,
  trackEnded, emptyFrames, noEncodingData, noIncomingData, segmentationError, encoderError,
  muxerProcessingError, SlowProcessing, TimecodeMismatch, processingHealth`. Quota detection is
  `/quota/i` or `"storage-full"`; a `noEncodingData` watchdog fires after 120 s of no frames;
  `window.ServerDate` supplies server-aligned time. User-facing issue toasts:
  `deviceStrugglingToRecord, cameraVideoRecordingLost, localVideoEncoderStall, micNotSendingAudio,
  indexDB, incompatibleBrowser, tabOpen, incognitoMode, corruptFilesystem, uploaderInitError,
  webRecordingFailedGeneric`.

### 1.3 Assessment

Riverside's design is "local parts + continuous multipart upload + one uploader tab + aggressive
rescan-on-open". Its recovery is excellent while the browser profile still exists; it degrades
exactly where ours must not: mobile has no offline capture at all, a partial track is a degraded
artifact (black/silent spans, no transcript), the cloud backup is a different-quality track, and
recovery depends on the user reopening the right browser profile. And nothing in Riverside
reconciles a live transcript against a later full-file transcription: Processing re-encodes and
the transcript is whatever the pipeline produced.

---

## 2. Other references (what to copy, what to avoid)

- **Zoom — raw on disk; conversion is the weak link.** `.zoom` files convert to
  `zoom_0.mp4`/`audio_only.m4a` at meeting end; interrupted meetings leave raw files the user must
  re-trigger conversion for (double-click, or the start/stop-a-new-meeting trick), and corrupt
  files recur ([UMD ITS](https://itsupport.umd.edu/itsupport?id=kb_article_view&sysparm_article=KB0016104),
  [UMich](https://teamdynamix.umich.edu/TDClient/30/Portal/KB/ArticleDet?ID=2939),
  [Zoom KB](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061761)). Copy: raw
  append-only data is unconditionally durable. Avoid: user-driven conversion.
- **Descript — closest UX analogue.** Recovery page (`web.descript.com/recovery`), shareable guest
  recovery link valid **7 days**, partial files kept editable, per-participant low-quality cloud
  backups, "recovery only works in the same browser or app you recorded with"
  ([recover](https://help.descript.com/record/recover),
  [rooms](https://help.descript.com/record/rooms-recover-replace)). Copy: partial-first editing,
  replace-partial-with-full. Avoid: expiry.
- **StreamYard — the upload page as product surface.** Same-browser/device page valid **30 days**;
  don't clear cookies; incognito unrecoverable; hosts can download partials; later completion
  **re-processes the full recording**
  ([doc](https://support.streamyard.com/hc/en-us/articles/14465428173460)).
- **Otter — the live/local hybrid.** On connectivity loss it "continue[s] to store audio locally…
  Once the device reconnects and Otter is reopened, any remaining audio can be uploaded, and the
  transcript will update automatically"
  ([practices](https://help.otter.ai/hc/en-us/articles/40917035359255),
  [troubleshooting](https://help.otter.ai/hc/en-us/articles/4403627500951)); offline mobile
  recording is documented
  ([FAQ](https://help.otter.ai/hc/en-us/articles/360048322493)). Copy: keep recording through the
  outage; transcript updates on reconnect. Weakness: no exposed audio archive.
- **Loom — what not to do.** Cloud-first; guidance is "wait ≥30 min, don't close the tab"; crashes
  "<0.1%" and unrecoverable ones go to support
  ([processing](https://support.atlassian.com/loom/kb/troubleshoot-a-video-stuck-in-processing),
  [uploads](https://support.atlassian.com/loom/kb/troubleshoot-and-fix-loom-video-upload-failures)).
  Lesson: cloud processing is not a durability contract.
- **Granola / Fireflies — capture without archive.** Granola "does not record or save audio or
  video at any point" ([docs](https://docs.granola.ai/help-center/taking-notes/transcription));
  Fireflies' no-bot mode "does not save audio or video files"
  ([KB](https://guide.fireflies.ai/articles/6666374717-how-to-record-meetings-without-a-bot-on-the-fireflies-desktop-app)).
  If the transcript is the only artifact, a bad ASR pass is unrecoverable.
- **Open source.** RecordRTC `DiskStorage` (blobs in IndexedDB) + `writeToDisk`/`getFromDisk`
  ([README](https://github.com/muaz-khan/RecordRTC)); resumable.js chunked retry
  ([repo](https://github.com/23/resumable.js)); tus 1.0 (`HEAD`→`Upload-Offset`, `PATCH`→resume,
  [spec](https://tus.io/protocols/resumable-upload)) — 02/04 reject tus only because no stateful
  tus server exists on our stack. Recordly's open issue #1128 = "save recording instead of
  discarding on unexpected window close"
  ([issue](https://github.com/webadderallorg/Recordly/issues/1128)). "tromzo" matches no notable
  repo.

---

## 3. Extracted architecture for Walfly

### 3.1 Client state machine (per recording)

```
     create session (POST /session)                    ── no buffer yet
idle ────────────────► arming ── capture starts ──► capturing ──────────────┐
                          │  (open buffer: OPFS dir / native file, write meta)│
                          │                                                    │
   WS unavailable / offline / sidecar 5xx                                     │
   ──► capturing(streaming=degraded, local=ok)  (tee continues; gaps[] updated)
                                                                              │
stop/15-min cap ──► finalizing (flush, close handle, patch WAV header, meta=stopped)
                                                                              │
   ──► draining (upload parts / whole file; idempotent; may span launches)
        │  server 2xx on /recover/complete (+ /finalize)
        ▼
      delivered ──► verification tick (/process) ──► done ──► GC buffer (after grace)
                        │ any failure → back to draining (backoff 0.5→30 s)
crash/app-kill at any point → launch sweep reads meta.json + cursor → resume capturing
   (if still "recording" and recent) or draining (if stopped), else offer download;
   a recording whose server doc vanished is case C3 in note 04 (re-create doc, attach).
```

This is Riverside's shape (`idle/uploading/uploaded/done` + launch-time `recoverUploads`) with
three deliberate differences: the tee is unconditional while streaming; draining is idempotent
and resumable across launches (their cursors are in-worker and profile-bound); reconciliation
chooses between streamed and batch transcripts (their partial-track model silently omits spans).

### 3.2 Persisted metadata (minimum to make recovery safe)

Aligned with notes 02/04: buffer files under `walfly-buffers/<recordingId>/` (web OPFS,
native `walfly-recordings/<sessionId>.wav`), cursor in `localStorage['walfly.recbuf.<recordingId>']`
with `meta.json` mirrored inside the buffer dir.

```jsonc
{
  "v": 1,
  "recordingId": "rec_01J…",      // server doc id — the idempotency key (04)
  "captureSessionId": "cap_01J…", // one per capture epoch (survives sidecar reset)
  "sampleRate": 16000, "channels": 1, "frameBytes": 3200, "frameMs": 100,
  "createdAt": 1760000000000, "updatedAt": 1760000900123,
  "write":  { "frames": 8112, "bytes": 25958400, "flushedAt": 1760000900000,
              "state": "recording|stopped",                 // OPFS truth; torn tail dropped
              "gaps": [{ "fromMs": 60000, "toMs": 65000, "reason": "ack_lag|disk|worker" }] },
  "stream": { "lastFrameSent": 8111, "lastAudioAck": 8090,   // WS watermark (plan §3)
              "segmentsBase": 400, "lastSegmentSeq": 87,     // chunkIndex continuity
              "lastSegmentPosted": 87 },                     // checkpoint watermark → /segments
  "deliver":{ "mode": "blob|local", "pathname": "recordings/rec_01J….wav",
              "uploadId": "mpu_…", "parts": [{ "n": 1, "etag": "…" }],  // etags survive reload
              "bytesUploaded": 8388608, "attempt": 3, "lastErrorAt": null,
              "state": "idle|uploading|complete|failed" },
  "coverage":{ "streamedMs": 840000, "localMs": 900000,       // decides transcriptSource (04)
              "gapMs": 5000 }
}
```

Rules: advance `deliver` only after a 2xx; part numbers are overwrite-idempotent so a lost etag is
re-uploaded, never guessed; `write` and `coverage` are rewritten by the buffer worker every ~1 s
(02), atomically; on resume, the truth is the file (`truncate(size - size % frameBytes)`), not the
cursor.

### 3.3 Failure modes and the answer for each

| Failure | What breaks | Handling (borrowed → improved) |
|---|---|---|
| Tab crash / reload | In-memory ring, WS buffer | OPFS file + 1 s flush survives (02); mount sweep resumes; WS ack ring rebuilt from `lastAudioAck` |
| App kill (native) | JS timers, background upload | File survives in `Paths.document` (03); launch sweep + Android WorkManager retry; first-class "Recovering…" UI |
| Network flap | WS, uploads | WS reconnect with jittered backoff (exists); disk untouched; uploader pauses on `offline`, resumes on `online` (Riverside pattern); uploads politely pause while WS is `reconnecting` >30 s |
| Sidecar 5xx / restart | Live segments, chunkIndex | `ready.reset` → bump `segmentsBase` (exists); local PCM still complete; coverage decides stream vs batch transcript |
| Server 5xx mid-upload | Part upload | Retry same part (idempotent number/offset), 0.5→30 s jittered; never re-generate the file |
| Duplicate delivery (retry after 2xx lost) | Double archive/transcript | Deterministic pathname + CAS attach (04) and/or `(recordingId, captureSessionId)` ingest key; server treats re-complete as 409 no-op |
| Duplicate uploaders (two tabs) | Concurrent part writes | OPFS sync-access-handle exclusive lock (02) + `navigator.locks`; if we ever run cross-tab, use Riverside's `uploadtabs` + master grace |
| Quota exceeded | Buffering | `estimate()` preflight ≥2× max at arm; on error mark `degraded`, keep streaming, toast; GC delivered buffers first |
| No writable storage (native) | Buffer open | Fail loud at arm ("can't record safely") rather than silently stream-only — Riverside's "device storage is running low" equivalent |
| Clock drift | Segment times, reconciliation | authoritative time = cumulative samples; server clock for cross-device; persist both |

---

## 4. Where each reference is weak + what Walfly should do instead

1. **Riverside: live and local are two separate recordings.** Local tracks are the artifact; the
   live view is a different (cloud) encode, and partial-track spans are black and absent from the
   transcript. **Ours:** one PCM source, tee'd — live transcript and archive are the same samples;
   gaps are explicit records.
2. **Riverside/Otter/Descript: no transcript reconciliation.** Late audio either updates the
   transcript unboundedly (Otter) or leaves holes (Riverside partials). **Ours:**
   `chooseTranscriptSource()` (04) compares `coverage.gapMs`/streamed coverage and picks stream vs
   batch; the losing copy is kept for audit.
3. **Everything: profile-bound recovery.** Riverside "same browser/profile", Descript "same
   browser or app", StreamYard "same browser and device", Otter "device originally used to
   record". **Ours:** delivery is automatic and progress-visible in-app ("Recovering previous
   recording"), no URL to remember; a stalled buffer is downloadable as WAV so users are never
   trapped by our server bugs.
4. **Riverside mobile cannot record offline (documented).** **Ours:** offline capture is the
   point; 03's native append path must work with the WS down, plus iOS background upload and
   Android best-effort retry.
5. **Granola/Fireflies bot-free mode discards audio.** **Ours:** PCM always archived; Opus-at-stop
   (02) shrinks it to ~2.7 MB when available.
6. **Loom: "cloud processing" as the durability story.** **Ours:** local file is the source of
   truth; delete only after `/recover/complete` + grace.
7. **tus/RecordRTC: transport without product semantics.** No dedup, reconciliation, or UX.
   **Ours:** keep tus-style offset semantics on the recovery handshake; part-cursor multipart as
   chosen (02/04).
8. **Zoom: conversion is a second failure mode.** **Ours:** WAV header patched in place (03);
   Opus/WebM derive from canonical PCM; no post-stop conversion step.
9. **Multi-tab duplicate uploads (Riverside solves, others don't).** **Ours:** single-writer lock
   at arm; if delivery-from-any-tab is added, copy `uploadtabs` + master election + grace, and
   make part writes idempotent anyway.

---

## 5. Gotchas

- **Browser storage is evictable and profile-bound**: same-profile recovery (Riverside/Descript
  docs); private browsing has no recovery (StreamYard docs; 02's OPFS/in-memory quirks). Call
  `navigator.storage.persist()` and show a private-mode honesty banner.
- **Crash loss window = flush interval** (~1 s at 1 Hz, 02); never `createWritable()` for the
  append path (temp-file swap loses everything on crash).
- **Never let buffering break capture**: tee writes are best-effort; a disk error degrades to
  stream-only with an explicit gap, never an exception in `onBuffer`/the worklet (03).
- **Reconciliation ambiguity is real**: merge streamed + batch text on the session clock (sample
  counts) with word-level dedup like the sidecar's forced-cut rule (`streaming-plan.md` §4.1);
  never concatenate by wall time.
- **Idempotency before elegance**: `recordingId` pathname + CAS on `audioUrl` (04) is what makes
  "retry after any 5xx" safe.
- **Backpressure interplay**: cap parts in flight and pause uploads while the WS is reconnecting —
  the live transcript is the product (Riverside pauses on `offline`, not congestion; be stricter).
- **Quota UX is required**: Riverside has a dedicated low-storage error and a `quotaExceeded`
  recorder state; mirror as a first-class banner, GC delivered buffers first.
- **The 15-min cap helps us**: 28.8 MB per session fits every browser quota, and the 7-day ITP
  horizon (02) exceeds our delivery SLO — buffer-until-delivered is always feasible if retries are
  prompt.

---

## Sources

Riverside docs (all claims quoted inline): [FAQ](https://riverside.fm/faq) ·
[track upload overview](https://support.riverside.com/hc/en-us/articles/5456549636253) ·
[finish uploading](https://support.riverside.com/hc/en-us/articles/5456562719517) ·
[pending uploads](https://support.riverside.com/hc/en-us/articles/5458227676957) ·
[stuck uploads](https://support.riverside.com/hc/en-us/articles/19135749320093) ·
[close app before upload](https://support.riverside.com/hc/en-us/articles/5592736661661) ·
[offline mobile](https://support.riverside.com/hc/en-us/articles/19680664067997) ·
[status guide](https://support.riverside.com/hc/en-us/articles/5457425335965) ·
[partial track](https://support.riverside.com/hc/en-us/articles/19508681766557).
Riverside code **[observed]**: [versions.json](https://riverside.com/builds/mfe/versions/versions.json) ·
[StudioLive manifest](https://riverside.com/builds/mfe/StudioLive/0.1791.1/mf-manifest.json) ·
recorder chunk `static/js/async/62.d6a85b59.js` ·
[web_uploader manifest](https://riverside.com/builds/mfe/web_uploader/0.23.0/mf-manifest.json)
(IndexedDB corroboration: [Reddit 2021](https://www.reddit.com/r/podcasting/comments/m9dsfg/help_needed_where_on_my_computer_does_riversidefm), anecdotal).

Comparisons: [Zoom/UMD](https://itsupport.umd.edu/itsupport?id=kb_article_view&sysparm_article=KB0016104) ·
[Zoom/UMich](https://teamdynamix.umich.edu/TDClient/30/Portal/KB/ArticleDet?ID=2939) ·
[Zoom KB](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061761) ·
[Descript recover](https://help.descript.com/record/recover) ·
[Descript Rooms](https://help.descript.com/record/rooms-recover-replace) ·
[StreamYard](https://support.streamyard.com/hc/en-us/articles/14465428173460) ·
[Otter practices](https://help.otter.ai/hc/en-us/articles/40917035359255) ·
[Otter troubleshooting](https://help.otter.ai/hc/en-us/articles/4403627500951) ·
[Loom processing](https://support.atlassian.com/loom/kb/troubleshoot-a-video-stuck-in-processing) ·
[Loom uploads](https://support.atlassian.com/loom/kb/troubleshoot-and-fix-loom-video-upload-failures) ·
[ScreenKite/Loom temp claim](https://www.screenkite.com/blog/fix-loom-upload-stuck-or-failed-to-process) ·
[Granola](https://docs.granola.ai/help-center/taking-notes/transcription) ·
[Fireflies](https://guide.fireflies.ai/articles/6666374717-how-to-record-meetings-without-a-bot-on-the-fireflies-desktop-app).
OSS: [RecordRTC](https://github.com/muaz-khan/RecordRTC) · [resumable.js](https://github.com/23/resumable.js) ·
[tus](https://tus.io/protocols/resumable-upload) · [Recordly #1128](https://github.com/webadderallorg/Recordly/issues/1128).
Storage engineering background: 02's sources (MDN OPFS/sync-access-handle, WebKit storage policy,
Chromium quota) apply unchanged.
