# 02 — Web persistent buffer + resumable upload

Feeds the implementation of a crash-safe local audio buffer for the Walfly web recorder
(16 kHz mono s16le, 100 ms frames / 3.2 KB, max 15 min ≈ 28.8 MB). Current client shapes:
`apps/mobile/lib/webMic.ts` (AudioWorklet tap), `pcm.ts` (100 ms `Int16Array` framing),
`streamClient.ts` (`push()` per frame), plan §3/§6, `packages/api/lib/storage.ts`
(`storageMode()` = `blob | local`).

## TL;DR

- **Buffer to OPFS from a dedicated Worker using `FileSystemSyncAccessHandle`**: acquire at
  record start, append at an ever-growing offset, `flush()` at ~1 Hz, close at stop. It is the
  only pattern that is append-native, fast, and crash-safe on Safari 15.2+, Firefox 111+,
  Chrome 102+. `createWritable()` is disqualified: it writes through a temp file and only swaps
  it in on `close()` (and Safari only shipped it in 26).
- **Keep raw PCM in the buffer.** Never encode on the capture path. Cheap upgrade *after stop*:
  WebCodecs `AudioEncoder({codec:'opus', sampleRate:16000, bitrate:24000})` in the same Worker
  → 2.7 MB instead of 28.8 MB; not available on Firefox-Android or Safari < 26 (≈22% of Safari
  sessions), where you keep the PCM chunk upload. PCM stays the canonical artifact either way.
- **Upload: your own chunked protocol with a persisted byte/part cursor, implemented as
  client-side multipart to Vercel Blob in prod and a local part-file append route in dev.**
  8 MiB parts (Blob requires ≥ 5 MiB per part except the last; the Vercel 4 MB function body
  limit makes *server-side* Blob multipart impossible — 5 MiB > 4 MB). In dev (`BLOB_READ_WRITE_TOKEN`
  unset) the same state machine PUTs ≤ 3 MiB chunks to a Next route that appends a `.part` file.
  Not tus (needs a stateful tus server), not `@vercel/blob/client`'s automatic `upload()`
  (retries in-page but exposes no cursor for cross-reload resume).
- **The OPFS file is the source of truth; upload is delivery.** A cursor + meta in localStorage
  plus `meta.json` inside the OPFS session dir lets any reload find the buffer and resume;
  a mount-time sweep resumes or offers recovery, and cleans up.
- Budget: 32 KB/s written, 9 000 `write()` + ~900 `flush()` calls per 15 min → well under 1% duty
  cycle, constant memory (~one frame + one 8 MiB read buffer during upload).

## 1. Storage: OPFS + sync access handle (Worker)

Comparison for an append-only 32 KB/s stream:

| | OPFS + `createSyncAccessHandle` | OPFS + `createWritable` | IndexedDB | Cache API |
|---|---|---|---|---|
| Append model | `write(buf,{at:offset})`, open-ended | stream, but **committed only at `close()`** | read-modify-write per chunk, or one record per frame | n/a — immutable responses |
| Crash mid-record | bytes up to last `flush()` survive | unclosed = temp file discarded → **total loss** | committed transactions survive | survives but no streaming writes |
| Safari | 15.2+ (Worker only) | **26**+ (`createWritable` BCD) | 8+ | yes |
| Firefox | 111+ | 111+ | 16+ | yes |
| Chrome | 102+ (Android 109) | 86+ | 24+ | yes |
| Cost at 10 Hz | ~µs per write | `keepExistingData:true` copies the 28.8 MB file at open; swap at close | ~9 000 records or quadratic blob growth | — |

Decisive detail: with `createWritable`, changes "won't be reflected in the file … until the stream
has been closed"; implementations write to a temp file and swap it in at `close()`, so a tab crash
with an open stream loses the whole recording. With the sync handle, `write()` lands in the storage
layer and `flush()` is the durability barrier (≤ 1 s loss). It also holds an **exclusive lock** per
file across the origin — free multi-tab protection.

**Write pattern (recorder side), exact:**

1. At start, the worker opens `walfly-buffers/<recordingId>/audio.pcm`:
   `getDirectoryHandle('walfly-buffers',{create:true})` → `getDirectoryHandle(recordingId,{create:true})`
   → `getFileHandle('audio.pcm',{create:true})` → `createSyncAccessHandle()`. On resume,
   `truncate(size - size % frameBytes)` drops a torn tail. Also `navigator.storage.persist()` and
   require `estimate().quota >= 2 × 30 MB`; fail loudly if not.
2. Main thread tees **every frame** from `streamClient.push()` via
   `postMessage({t:'frame', ab}, [ab])` — 10 msgs/s of 3.2 KB, negligible. Either post a fresh
   3.2 KB copy, or transfer the original buffer only after `push()` has made its synchronous WS
   copy in the same tick (otherwise the transferred buffer is neutered).
3. Worker keeps `offset`; `write(view,{at:offset})`; verify the full byte count. Every
   `FLUSH_MS = 1000` (and just before signalling a part upload) `flush()`, rewrite `meta.json`,
   and post `{t:'flushed',bytes}` so the main thread advances the cursor. Crash loss ≤ 1 s.
4. At stop the batcher emits the tail, the worker flushes, writes `state:'stopped'`, closes.
5. Uploads read through the same worker (one `read(view,{at})` per 8 MiB part), serialized with
   writes so nothing contends for the lock.

```ts
// buffer.worker.ts
let handle: FileSystemSyncAccessHandle; let offset = 0; let lastFlush = 0;
const FLUSH_MS = 1000;
async function open(bufferId: string, frameBytes: number) { /* mkdir chain, create handle */
  const size = handle.getSize();
  const drop = size % frameBytes; if (drop) handle.truncate(size - drop);
  offset = size - drop;
}
function frame(ab: ArrayBuffer) {
  const n = handle.write(new Uint8Array(ab), { at: offset });
  if (n !== ab.byteLength) throw new Error('short write');   // surface as degraded
  offset += n;
  if (performance.now() - lastFlush >= FLUSH_MS) { handle.flush(); lastFlush = performance.now();
    void writeMeta({ frames: offset / 3200, bytes: offset, state: 'recording' }); }
}
function stop() { handle.flush(); handle.close(); /* meta: state='stopped', bytes=offset */ }
function readPart(start: number, len: number) { const a = new Uint8Array(len);
  handle.read(a, { at: start }); return a; }                  // transferred back to main thread
```

**Backpressure rule:** the worker queue absorbs bursts and never blocks capture; bound it at 60 s of
audio and, on overflow (disk stall), drop oldest frames into `meta.write.gaps` — the same explicit-gap
policy as the WS path. If the worker dies, keep a 120 s in-memory ring on the main thread (mirrors
`MAX_BUFFERED_FRAMES`) and replay; worst case the buffer is degraded, the WS path still has the audio.

IndexedDB is not the primary: one record per 100 ms frame is 9 000 records per recording, and a grown
Blob via read-modify-write is O(n²). Keep a small IDB backend **only** as the private-browsing
fallback (Safari rejects OPFS there — §6).

## 2. Encoding: PCM now, Opus at stop as the upgrade

| Option | 15 min size | Capture-path CPU | Availability |
|---|---|---|---|
| Raw PCM s16le 16 kHz mono | **28.8 MB** | 0 | everywhere |
| WAV (PCM + 44 B header) | 28.8 MB | 0 | everywhere (PyAV/ffmpeg read it) |
| Opus 16 kbps | **1.8 MB** | — (post-stop) | WebCodecs: Chrome 94+, Firefox 130+ desktop, Safari 26+ |
| Opus 24 kbps | **2.7 MB** | — | as above |
| Opus 32 kbps | 3.6 MB | — | as above |

WebCodecs coverage as of late 2026: 95.6% of global usage (caniuse, Sep 2026); `AudioEncoder` is
Chrome/Edge 94+, Firefox 130+ (desktop only — Firefox-Android = unsupported), Safari 26+
(WebKit's AudioToolbox implementation supports **Opus and AAC**). Opus encode of Safari sessions in
real traffic ≈ 78% (rest are pre-26), i.e. ~22% fallback.

Recommendation: **raw PCM remains the only thing written during recording.** At stop, if
`AudioEncoder.isConfigSupported({codec:'opus', sampleRate:16000, numberOfChannels:1, bitrate:24000})`
is true, run a Worker pass over the OPFS file: `AudioData` (16 kHz, s16) → `EncodedAudioChunk`s →
mux to WebM/Ogg with a small muxer → `audio.opus` (~2.7 MB, one request / one part). Else fall back
to the PCM chunk flow. Do **not** encode live: it puts a libopus/WASM dependency and CPU on the
capture path for a 10× win you get offline, seconds later, in a Worker. Chrome's Opus encoder accepts
16 kHz natively (libopus rates 8/12/16/24/48 k; others resample to 48 k), so no client resampling.
Prefer muxing client-side to inventing a raw-Opus contract for the sidecar.

## 3. Upload: own cursor protocol, Blob multipart in prod, part-file append in dev

| Option | Verdict |
|---|---|
| **tus.io (`tus-js-client`)** | Wrong fit: needs a stateful tus server that owns the file and appends per PATCH. On Vercel there is no shared disk, so every PATCH would append inside Blob/S3 anyway — the same problem, plus a dependency and a second API surface. Rejected. |
| **Blob client `upload()` with `handleUpload`** | Bypasses the 4 MB function-body limit and retries failed parts, but the automatic mode has **no cross-reload resume** (no exposed cursor) and no dev mode without Blob. Keep as the whole-file one-shot fallback. |
| **Server-side Blob multipart from our route** | Impossible on Vercel: min part 5 MiB > 4 MB request-body limit. |
| **Plain chunked POSTs appending server-side** | Works in dev (local disk, 100 MB cap); on Vercel it becomes per-chunk Blob parts + a final stitch. |
| **Chosen: client-side Blob multipart (= S3-style parts: 8 MiB, etags, `complete`) + own cursor; dev variant = ≤ 3 MiB chunk POSTs** | One client state machine, resumable across reloads, dev parity. |

**Flow (prod).**

1. Start: `POST /api/recordings/{id}/audio/init`
   → `{ mode:'blob', pathname:'recordings/{id}/audio.wav', handleUploadUrl:'/api/recordings/{id}/audio/blob-token', partSize: 8388608, receivedBytes:0 }`.
   The token route authenticates the session and returns a client token scoped to that pathname
   (`generateClientTokenFromReadWriteToken`, or `handleUpload`, which receives a `multipart` flag).
2. Every 8 MiB accumulated (≈4.4 min of PCM) upload one part: `uploadPart(pathname, blob8MiB,
   { access, token, uploadId, key, partNumber })` — browser → Blob directly, so the 4 MB Vercel limit
   never applies; 1–2 parts in flight. Persist `{n, etag}` **after** each 2xx. Last part may be < 5 MiB.
3. Stop: upload the final partial part, complete (`completeMultipartUpload`, client- or server-side),
   then `POST /api/recordings/{id}/audio/complete` `{ blobUrl, pathname, bytes, sampleRate, channels,
   contentType }`; the route `head()`s the blob, writes `audioUrl`+`sizeBytes` on the recording doc,
   and triggers the usual finalize/process ticks. Server-side complete (client sends
   `{uploadId, key, parts}`) is preferable if the client token cannot complete an upload it did not
   create — verify with a smoke test.
4. Delete the OPFS dir only after `complete` returns 200 (or 409 already-complete).

**Flow (dev, `BLOB_READ_WRITE_TOKEN` unset).** Same states, different transport: `init` returns
`{ mode:'local', chunkSize: 3145728, receivedBytes: <size of .data/audio/{id}.pcm.part> }`; each part is
`PUT /api/recordings/{id}/audio/part` with `X-Offset` and a ≤ 3 MiB body (under the 4 MB limit). The
route appends only if `X-Offset === stat.size` (else `409 {receivedBytes}`) under a per-recording lock,
and `POST .../audio/complete` writes the 44-byte RIFF header from the actual length, renames to
`{id}.wav`, sets the local `audioUrl` as `storage.ts` already does, and enforces the 100 MB cap.
Resuming is server-authoritative: on 409 the client snaps its cursor to `receivedBytes` and re-sends
the straddling chunk.

**Cursor schema** (`localStorage['walfly.recbuf.<recordingId>']`, one small JSON, rewritten atomically):

```jsonc
{ "v":1, "recordingId":"rec_01J…", "bufferId":"rec_01J…",
  "sampleRate":16000, "frameBytes":3200, "createdAt":1760000000000,
  "write":  { "frames":8112, "bytes":25958400, "flushedAt":1760000900000, "gaps":[] },
  "upload": { "mode":"blob", "pathname":"recordings/rec_01J…/audio.wav",
              "uploadId":"mpu_…", "key":"…",
              "parts":[{"n":1,"etag":"\"a1b\""}], "bytesUploaded":8388608,
              "state":"idle|uploading|complete|failed", "attempt":3, "lastErrorAt":null },
  "state":"recording|stopped|uploaded|failed|degraded",
  "updatedAt":1760000900123 }
```

Rules: `upload` advances only after a 2xx; `parts` holds the etags `complete` needs; on resume,
`nextPart = parts.length + 1`, and re-uploading that number is safe (part numbers are
overwrite-idempotent, so a lost etag is simply replaced). `meta.json` in the OPFS dir mirrors
`write` + `state`, so the file reconciles even if localStorage was cleared.

**Failure modes:** token expiry → re-mint and continue with the same `uploadId`; drop mid-part →
retry the same part with backoff (0.5→30 s), cursor unchanged; tab closed mid-part → same;
`uploadId` expired/GC'd → restart the multipart upload (bounded ≤ 29 MB); Blob/dev-server errors →
keep the OPFS file, retry on next launch. "Upload failed" never means "recording lost".

## 4. Recovery and cleanup

- **Naming/enumeration:** `walfly-buffers/<recordingId>/{audio.pcm, audio.opus?, meta.json}`, where
  `recordingId` is the id from `POST /api/recordings/session` — buffer and server doc are joinable.
- **Mount sweep:** list `walfly-buffers/*`, read `meta.json` + the localStorage cursor.
  `recording` state, `updatedAt` older than ~30 s, no live `streamClient` → "Recover previous
  recording": resume upload if the recording doc still exists (`PATCH /finalize` after complete),
  else offer download. `stopped` → resume silently. `uploaded` → delete after a 60 s grace.
- **Multi-tab:** the sync handle's exclusive lock is the fallback; use
  `navigator.locks.request('walfly:rec', {ifAvailable:true})` to refuse a second recorder and
  BroadcastChannel to say "recording in tab X".
- **Cleanup:** delete on confirmed complete; unlinked orphans after 7 days (Safari's eviction
  horizon); cap `walfly-buffers` at ~120 MB (4 sessions), evicting oldest `uploaded`/orphan first,
  never an active one.

## 5. Perf / battery budget (15 min, 16 kHz mono)

| Item | Value | Note |
|---|---|---|
| Data written | 28.8 MB | 32 KB/s, 9 000 frames |
| `write()` calls | 9 000, ~µs each | worker thread, never main |
| `flush()` calls | ~900 (1 Hz) + 1 | fsync; 0.2–2 ms on SSD → ≤ 1.8 s total, < 0.2% duty; **no-op in Chrome incognito** (memory-backed) |
| Main-thread cost | 10 postMessage/s, 3.2 KB copy | ~0.01% CPU; no decode/encode |
| Memory | ~1 frame + 1 part buffer | constant; never 29 MB in JS heap |
| Post-stop Opus encode | ~2–10 s desktop, ~5–20 s low-end mobile (estimate; measure) | worker, off capture path |
| Upload | 28.8 MB @ 5 Mbit/s ≈ 46 s; @ 1 Mbit/s ≈ 4 min | chunked + resumable; Opus ≈ 4 s / 22 s |

The dominant battery cost stays the microphone + WebSocket + server ASR. OPFS appends add noise.

## 6. Gotchas

| Situation | Behaviour | Handle it |
|---|---|---|
| **Safari Private Browsing** | OPFS rejected ("unknown transient reason"); IDB runs in-memory | Detect via a `getDirectory()` probe; fall back to the IDB backend (one record/1 s batch) and tell the user recovery is impossible after closing the tab |
| **Firefox Private Browsing** | OPFS disabled from FF 109; supported again (encrypted, ephemeral) in **FF 153**; older builds throw a SecurityError on `getDirectory()` | Same IDB fallback; catch and degrade |
| **Chrome incognito** | OPFS works but is in-memory; quota ≈ (0.15–0.2 × RAM)/3; "clear on close" caps session quota at ~300 MB | 29 MB fits; warn that closing the last incognito window discards the buffer |
| **Quota exceeded** | `QuotaExceededError` on write/flush (all engines); Safari also prompts in older versions | Preflight `estimate()` ≥ 2× max; on error mark `degraded`, stop buffering, keep recording via WS, banner |
| **Tab kill while writing** | Bytes after last `flush()` may be missing or the last frame torn | Resume: `truncate(size - size % frameBytes)`; reconstruct `t_ms` from byte offsets |
| **7-day ITP eviction (Safari)** | Script-writable storage deleted after 7 days without interaction; installed web apps exempt; `persist()` granted only by heuristic (Home-Screen app) | Call `persist()`; treat local buffer as ≤ days-lived; upload promptly |
| **Multi-tab** | Sync handle exclusive lock; second tab fails | Web Locks + BroadcastChannel; never two recorders |
| **Storage.clear / user clears site data** | OPFS + localStorage vanish together | Nothing to do; the server already has segments from `/segments` |
| **`createWritable` semantics** | Temp file swap on close; a crash loses the file | Do not use for the append path |
| **Safari < 26 & main thread** | `createSyncAccessHandle` is Worker-only everywhere | Keep the buffer architecturally a worker |
| **Firefox-Android / Safari < 26** | No `AudioEncoder` | PCM chunk upload only |
| **Upload while recording competes for bandwidth** | WS audio frames are tiny (32 KB/s) | Cap parts in flight; pause uploads if the WS reports `reconnecting` for > 30 s |

## Sources

- MDN: [`FileSystemSyncAccessHandle`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle) · [`createWritable()` temp-file swap](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable) · [Storage quotas & eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) · BCD [FileSystemFileHandle](https://github.com/mdn/browser-compat-data/blob/main/api/FileSystemFileHandle.json) / [StorageManager](https://github.com/mdn/browser-compat-data/blob/main/api/StorageManager.json) / [AudioEncoder](https://github.com/mdn/browser-compat-data/blob/main/api/AudioEncoder.json)
- WebKit: [Storage Policy updates (Safari 17 quotas, persist heuristics)](https://webkit.org/blog/14403/updates-to-storage-policy/) · [OPFS announcement (unavailable in Private Browsing)](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/) · [Tracking Prevention (7-day script storage)](https://webkit.org/blog/tracking-prevention/) · [Safari 26 WebCodecs AudioEncoder](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/) · [WebKit PR 37699 (Opus + AAC only)](https://github.com/WebKit/WebKit/pull/37699)
- web.dev: [Storage for the web (Chrome incognito ≈5%, 300 MB session cap)](https://web.dev/articles/storage-for-the-web) · [Persistent storage](https://web.dev/articles/persistent-storage)
- caniuse: [WebCodecs 95.55% global, Sep 2026](https://caniuse.com/webcodecs) · [Opus encode matrix per browser/OS](https://webcodecsfundamentals.org/codecs/opus.html)
- Chromium: [libopus sample rates 8/12/16/24/48 k](https://chromium.googlesource.com/chromium/src/+/141.0.7390.122/media/audio/audio_opus_encoder.cc) · [incognito quota = 15–20% RAM / per-origin pool÷3, 300 MB session cap](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/storage/browser/quota/quota_settings.cc)
- Mozilla: [bug 1785125 OPFS disabled in Private Browsing](https://bugzilla.mozilla.org/show_bug.cgi?id=1785125) · [bug 1975760 OPFS in PBM, fixed FF 153](https://bugzilla.mozilla.org/show_bug.cgi?id=1975760)
- Vercel: [Blob client uploads / handleUpload](https://vercel.com/docs/vercel-blob/client-upload) · [Blob SDK (multipart, 5 MB minimum part)](https://vercel.com/docs/vercel-blob/using-blob-sdk) · [Signed URLs / handleUploadPresigned](https://vercel.com/docs/vercel-blob/vercel-signed-urls)
- tus: [tus-js-client (`findPreviousUploads`, `resumeFromPreviousUpload`)](https://github.com/tus/tus-js-client)
- Engineering posts: [detectIncognito (Safari/Firefox OPFS probe; incognito flush is a no-op)](https://detectincognito.com/how-it-works) · [Lit.Build OPFS append-only `data.bin` + `index.jsonl` (2025-12)](https://www.lit.build/blog/beyond-mediarecorder-building-a-high-performance-4k-screen-recorder-with-webcodecs-opfs) · [crash-resilient meeting recording: savepoints + presigned parts (2026-03)](https://jieun.dev/en/blog/building-a-crash-resilient-end-to-end-meeting-recording-pipeline-in-the-browser/)
