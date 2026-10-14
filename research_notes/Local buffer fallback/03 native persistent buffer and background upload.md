# 03 — Native persistent buffer + background upload

Scope: tee every `expo-audio` `AudioStream` `onBuffer` frame (16 kHz mono int16, ~100 ms) into a local file while the WebSocket streams to the sidecar, then upload the file on stop or when streaming/network was unavailable. Verified against the installed packages (`expo-file-system@57.0.6`, `expo-audio@57.0.4`) and the SDK 57 native sources.

## TL;DR

1. **Write path**: `expo-file-system`'s new `File`/`FileHandle` API. Open one append handle per session (`file.open(FileMode.Append)`), call `handle.writeBytes(new Uint8Array(buffer.data))` inside `onBuffer` (~10×/s, 3.2 KB each). Synchronous JSI call, no base64, no per-call open. Cost is a rounding error: <0.2% CPU against the mic + WebSocket + ASR; battery impact is negligible. Do **not** use the legacy base64 `writeAsStringAsync` path, and do not use `file.write()` per buffer (re-opens the file every call).
2. **Format**: write one `.wav` per session: a 44-byte RIFF/WAVE header first, then raw int16 PCM appended; patch the header sizes once on stop (sync write at offset 0, no 27 MB copy). Raw PCM → WAV in one file, crash-recoverable, self-describing, accepted by the sidecar and by browsers. No m4a: encoding adds CPU, latency and a second failure mode for zero benefit here.
3. **Crash safety**: `Paths.document/walfly-recordings/<sessionId>.wav` + a sibling `<sessionId>.json` written at start/stop/failure. Documents survives OS cache purging; a small metadata sidecar makes orphan files self-describing for launch-time recovery. iOS default data protection (Class C) keeps background reads working while the phone is locked.
4. **Background upload**: iOS — `file.upload()` / `file.createUploadTask()` already uses a **background `NSURLSession` by default** (`sessionType: 'background'`) and can finish while the app is suspended. Android — managed Expo has no equivalent; use in-process upload on stop with UI, plus an `expo-background-task` (WorkManager, ≥15 min) retry worker and a launch-time sweep. "Best effort" = persisted file + retry until the server confirms.
5. **Transport switch**: the server already exposes `GET /api/recordings/upload` (`storage: 'blob' | 'local'`, `maxUploadBytes`). Local mode uploads the WAV body to our own route; Vercel mode mints a Blob client token and the device PUTs the file straight to Blob (bypasses the 4.5 MB function body limit).

---

## 1. The write path (exact sketch)

`expo-audio`'s `AudioStream` emits events on the JS thread at ~10 Hz on both platforms: iOS installs an `AVAudioEngine` tap with `bufferSize = sampleRate * 0.1` ([AudioStream.swift, sdk-57](https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/ios/AudioStream.swift)), Android reads `DEFAULT_BUFFER_DURATION_MS = 100` ms per iteration ([AudioStream.kt, sdk-57](https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/android/src/main/java/expo/modules/audio/AudioStream.kt)). Each buffer is one `ArrayBuffer` of 3,200 bytes at 16 kHz mono int16.

`FileHandle.writeBytes(bytes: Uint8Array): void` is a **synchronous** native call — on iOS it is a `FileHandle.write(contentsOf:)`, on Android a `FileChannel.write` ([FileSystemFileHandle.swift](https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemFileHandle.swift), [FileSystemFileHandle.kt](https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/android/src/main/java/expo/modules/filesystem/FileSystemFileHandle.kt)). No base64, no async hop, no per-call open. One caveat: on iOS `open()` uses `FileHandle(forWritingTo:)`, which **throws if the file does not exist** (Android creates it), so create the file first — this is the portable pattern.

```ts
// lib/recordingBuffer.ts — native only; web has no expo-file-system File API.
import { Directory, File, FileMode, Paths } from 'expo-file-system';

const DIR = new Directory(Paths.document, 'walfly-recordings');
const WAV_HEADER_BYTES = 44;

export class RecordingBuffer {
  private file: File | null = null;
  private handle: ReturnType<File['open']> | null = null;
  private sampleRate = 16000;
  private channels = 1;
  private pcmBytes = 0;

  start(sessionId: string, sampleRate: number, channels = 1): string {
    DIR.create({ intermediates: true, idempotent: true }); // throws only on real errors
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.pcmBytes = 0;
    this.file = new File(DIR, `${sessionId}.wav`);
    this.file.create({ overwrite: true });                 // fresh session id ⇒ safe
    this.handle = this.file.open(FileMode.Append);         // cursor at EOF
    this.handle.writeBytes(new Uint8Array(WAV_HEADER_BYTES)); // placeholder, patched on stop
    return this.file.uri;
  }

  /** Hot path: called from AudioStream onBuffer, ~10×/s. Must be cheap and must never throw. */
  append(pcm: ArrayBuffer): void {
    const h = this.handle;
    if (!h) return;
    try {
      h.writeBytes(new Uint8Array(pcm)); // zero-copy view; data is already s16le
      this.pcmBytes += pcm.byteLength;
    } catch (err) {
      console.warn('[Buffer] tee failed; streaming continues', err); // never break the live stream
    }
  }

  /** Commit: write the real header at offset 0 instead of copying 27 MB. */
  finish(): { uri: string; pcmBytes: number; durationMs: number } {
    const h = this.handle;
    this.handle = null;
    h?.close();                                  // close before patching/reopening
    const f = this.file!;
    const commit = f.open(FileMode.ReadWrite);
    commit.offset = 0;
    commit.writeBytes(wavHeader(this.pcmBytes, this.sampleRate, this.channels));
    commit.close();
    const durationMs = Math.round((this.pcmBytes / (this.sampleRate * 2 * this.channels)) * 1000);
    return { uri: f.uri, pcmBytes: this.pcmBytes, durationMs };
  }
}

function wavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const bytesPerFrame = 2 * channels;
  v.setUint32(0, 0x52494646, false);                    // "RIFF"
  v.setUint32(4, 36 + dataBytes, true);
  v.setUint32(8, 0x57415645, false);                    // "WAVE"
  v.setUint32(12, 0x666d7420, false);                   // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                             // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPerFrame, true);    // byte rate
  v.setUint16(32, bytesPerFrame, true);                 // block align
  v.setUint16(34, 16, true);                            // bits/sample
  v.setUint32(36, 0x64617461, false);                   // "data"
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}
```

Wiring into `useRecordingUpload`'s existing `onBuffer` (the tee goes before the batcher so file coverage is never behind the stream):

```ts
onBuffer: (buffer: AudioStreamBuffer) => {
  if (!nativeActiveRef.current) return;
  bufferRef.current?.append(buffer.data);          // ← new, sync, ~50 µs
  pushSamples((b) => b.pushInt16(new Int16Array(buffer.data)), buffer.sampleRate || 16000);
}
```

Start it right after `nativeStream.stream.start()` (when the real `sampleRate` is known), and call `finish()` before/at `stopAndUpload` — before the socket teardown, so a `finish()` failure can't strand an unpatched file.

**Cost.** 10 writes/s × 3.2 KB ≈ 32 KB/s into the OS page cache (no `fsync`). A JSI sync call plus a 3.2 KB `write()` is tens of microseconds: ≈0.1–0.5 ms of JS-thread time per second (<0.05% of one core); a 15-minute file is 27.5 MiB. The microphone, WebSocket and ASR still dominate the battery. The real JS-thread caveat is anything *else* heavy in `onBuffer`: buffers queue when JS is busy and there is no backpressure signal, so keep the path lean and sequence the WAV by bytes written, not buffer count.

**If you would rather not touch JS at all:** upstream `expo-audio` on `main` (SDK 58) adds `stream.startFileRecordingAsync()` / `stopFileRecordingAsync()` to `AudioStream`, writing WAV/PCM natively alongside `onBuffer` ([AudioStream.types.ts, main](https://github.com/expo/expo/blob/main/packages/expo-audio/src/AudioStream.types.ts)). This is **not** in 57.0.4 or 57.0.5 (verified in the installed package and on unpkg), so it is a future upgrade, not a 2026 SDK 57 option.

## 2. Format: raw PCM vs container

Write **`.wav` with a placeholder 44-byte header, patched at stop** (or at recovery). Rationale:

- WAV is trivial (44 bytes, given above), self-describing, and accepted by the sidecar and by browser playback. `audioContentType: audio/wav` matches the existing `Recording` shape.
- Patching avoids rewriting 27.5 MB at stop and avoids a second file. `FileMode.ReadWrite` + `offset = 0` is supported for app-private files (the SAF `content://` restrictions don't apply).
- Raw `.pcm` is equally valid for the sidecar but not self-describing once it lands in Blob or is served from `audioUrl` — and with Blob client-direct uploads the server never sees the bytes.
- Containers (m4a/AAC) add encoding CPU/latency and a failure mode for no benefit; the sidecar takes PCM/WAV.
- A placeholder header means the file is *not* a valid WAV until the patch — deliberate: size is the recovery truth and the patch is the commit point. Recovery must tolerate a 44-byte-prefixed PCM file with a garbage header.

## 3. Crash-safety design

**Location — `Paths.document/walfly-recordings/`.** `document` is "safe from being deleted by the system"; `cache` may be purged under storage pressure ([FileSystem docs](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/)). For a file whose purpose is surviving until upload, `cache` is the wrong trade. Caveat: Documents is iCloud-backed on iOS and inside Android Auto Backup (25 MB/app — see gotchas), so cleanup after upload is not optional.

**What makes a file recoverable.** The `.wav` size is the watermark (`pcmBytes = size - 44`); the `.json` sidecar makes it self-describing and carries the server relationship. Write the JSON at start, at stop, and on upload-state transitions — never per buffer.

**Schema** (small, versioned, one per session):

```json
{
  "v": 1,
  "sessionId": "b6f0…",              // same id used for /api/recordings/session
  "startedAtMs": 1760000000000,
  "stoppedAtMs": 1760000900000,      // null while recording
  "sampleRate": 16000,
  "channels": 1,
  "encoding": "pcm_s16le",
  "container": "wav",                // headerBytes: 44
  "pcmBytes": 28800000,              // recomputed from file size at recovery
  "durationMs": 900000,
  "state": "recording | stopped | uploading | uploaded | failed | aborted",
  "stream": { "lastAckedSeq": 274, "lastAckedMs": 27400, "lastChunkIndex": 3 },
  "server": { "sessionCreated": true, "finalized": false, "audioAttached": false },
  "upload": { "target": "blob | local", "pathname": "recordings/b6f0….wav",
              "attempts": 2, "lastError": "HTTP 503", "updatedAtMs": 1760001000000 },
  "device": { "platform": "ios", "appVersion": "1.0.0" }
}
```

`stream.lastAckedMs` is the "live coverage watermark": everything after it was never confirmed by the sidecar, so a recovered upload can be re-transcribed wholesale (or gap-filled) server-side.

**Launch sweep** (`recoverOrphanBuffers()` in the same effect that already handles `walfly_active_recording_session`):

1. `new Directory(DIR).list()`; for each `.json` with `state !== 'uploaded' | 'aborted'`:
2. If the `.wav` is missing → mark `failed`, surface in UI, cleanup later.
3. Else compute `pcmBytes = wav.size - 44`; **idempotently patch the header** (`FileMode.ReadWrite`, offset 0) — this is also what heals a kill during recording; update `durationMs`/`pcmBytes`; if `state === 'recording'`, set `stopped`.
4. `state === 'uploading'` is ambiguous (the upload may have completed without JS seeing it): **reconcile server-side** — `GET /api/recordings/{id}`; if `audioUrl` is set, mark `uploaded` + cleanup; else retry with a fresh token and the same pathname.
5. Enqueue the upload (`target` decides route, §4); on 2xx + server confirmation delete `.wav` + `.json`.

**Cleanup policy.** Delete immediately on confirmed upload and on user-cancel (`aborted`). Never delete while `recording`. Sweep at launch: drop `failed` files older than 7 days or with ≥5 attempts; enforce a directory cap (e.g. 300 MB) by deleting the oldest non-recording files first. `Paths.availableDiskSpace` gives a pre-flight check before starting a 27 MB session.

Also keep the current server-side orphan handling: a session whose app died before finalize should still be finalized by the sweep, even if the local file is empty — exactly like the web `localStorage` path does today.

## 4. Background upload

**What the platform gives us in 2026:**

- **iOS, already in SDK 57**: `File.upload()` and `file.createUploadTask()` use a background `URLSession` (`<bundle>.expo-file-system.network-task.background`, `sessionSendsLaunchEvents = true`, `isDiscretionary = false`); `sessionType` defaults to `'background'` ([FileSystemUploadTask.swift](https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemUploadTask.swift), [FileSystemDownloadTask.swift](https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemDownloadTask.swift), [docs](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/)). The transfer runs in `nsurlsessiond` while the app is suspended, and iOS relaunches the app to deliver completion. Limits: the JS `UploadTask` is **not restored after termination** (promise/progress only live with the original JS runtime), and a user force-quit cancels all background transfers until the next manual launch ([Apple](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:))).
- **Android**: `File.upload()` is OkHttp on a coroutine — it dies with the process. The managed-Expo primitive for deferred work is `expo-background-task` (WorkManager/BGTaskScheduler, single worker, ≥15 min, background-only, battery + network gated, stopped by a user kill) ([docs](https://docs.expo.dev/versions/v57.0.0/sdk/background-task/)).
- **Do not** use `expo/fetch` for the durable path (not a background session). `react-native-background-upload` works but is a native module whose New-Architecture support must be verified — last resort.

**Recommendation (in order):**

1. **Upload immediately on stop, in-process, with visible progress** — 27.5 MB is seconds on Wi-Fi/LTE. Use `File.createUploadTask(url, { onProgress })`, and make the *server* the source of truth (success = `audioUrl` present), never the client's promise.
2. **Register the `expo-background-task` worker only while a pending buffer exists** (`minimumInterval: 15`); it re-runs "list pending → upload → reconcile" and unregisters when empty. Best effort by design: WorkManager guarantees *eventually*, iOS may run it hours later.
3. **Sweep at every launch/foreground** (§3) — the real reliability guarantee: force-quit and reboot heal the next time the user opens the app.
4. Beyond that, the only managed-Expo upgrade is a custom native module (`WorkManager` + the existing background `URLSession`) — avoidable, since (1)–(3) already satisfy "never lose audio".

**Vercel transport:** the function body limit is 4.5 MB ([Vercel KB](https://vercel.com/kb/guide/how-to-upload-and-store-files-with-vercel)), so every real session must go client-direct to Blob on Vercel. Server route returns everything the device needs; the client does not hardcode the Blob protocol:

```ts
// server: POST /api/recordings/:id/audio-token  → handleUpload({ onBeforeGenerateToken })
// returns { uploadUrl, headers, pathname }
const { uploadUrl, headers } = await postAudioToken(sessionId);

await file.upload(uploadUrl, {            // e.g. https://vercel.com/api/blob/?pathname=<encoded>
  httpMethod: 'PUT',
  headers: {                              // authorization: Bearer <clientToken>, x-api-version: 12,
    ...headers,                           // x-content-type: audio/wav, x-vercel-blob-access: public|private,
  },                                      // x-add-random-suffix: 0  (retry with the same pathname is safe)
  sessionType: 'background',              // iOS default; explicit for clarity
  uploadType: UploadType.BINARY_CONTENT,
});
```

The token is pathname-scoped and expires (1 h default via `handleUpload`), the Blob service calls back to `onUploadCompleted` (local dev needs `VERCEL_BLOB_CALLBACK_URL`), and error codes (`client_token_expired`, `file_too_large`, `content_type_not_allowed`) tell you whether to re-mint. In local/self-hosted mode (`storage: 'local'`) upload the WAV body straight to our own route with the same native task; chunked 2 MB resumable uploads are only worth building if you later need resume mid-file.

## 5. Gotchas

| # | Gotcha | Consequence / mitigation |
|---|---|---|
| 1 | iOS interruptions (call, Siri, route change) | The engine tap stops; `AudioStream` exposes no interruption event and `isStreaming` can stay true, so buffers silently stop → a hole in file and stream. Detect a stall via `buffer.timestamp`; stop or restart capture; keep the partial file. |
| 2 | App killed (OOM / swipe) mid-recording | Bytes already written survive process death (kernel flushes the page cache); only power loss loses the tail. Recover via size-derived `pcmBytes` + header patch. |
| 3 | User force-quit on iOS | Background `URLSession` transfers cancel (`NSURLErrorCancelledReasonUserForceQuitApplication`); nothing relaunches until the user opens the app. File stays; launch sweep retries. |
| 4 | File handle invalidation | iOS `open()` throws if the file doesn't exist → `create()` first. Deleting/moving an open file fails or invalidates the handle; handles are SharedRefs and may close on GC. Hold it in a ref for the session and `close()` before patch/delete/move. |
| 5 | JS thread / callback frequency | `writeBytes` is synchronous; 10×3.2 KB/s is fine (<0.2% CPU), but keep `onBuffer` lean: never base64 (+33% bytes, string churn), never `file.write()` per buffer (opens per call). |
| 6 | iOS data protection | Default Class C (`CompleteUntilFirstUserAuthentication`): background reads work while locked, but **fail before the first unlock after a reboot** ([Apple](https://support.apple.com/guide/security/data-protection-classes-secb010e978a/web)). Retry later, don't treat as permanent. |
| 7 | Backup quotas | iOS Documents → iCloud backup; Android Auto Backup includes `filesDir` up to 25 MB/app, so a 27.5 MB WAV can exceed the quota ([Android](https://developer.android.com/identity/data/autobackup)). Clean up promptly; excluding `walfly-recordings/` via a config plugin is the long-term fix. |
| 8 | Vercel 4.5 MB body limit | Even the smallest session exceeds it; use Blob client-direct on Vercel, the normal route only for local/self-hosted. |
| 9 | iOS background session quirks | Background transfers are throttled/opportunistic (historical slow-upload reports, [#26754](https://github.com/expo/expo/issues/26754)), upload-from-file only, and the JS promise never settles if the app is terminated — reconcile server-side, don't await it. |
| 10 | Simulator/emulator | `BGTaskScheduler` is unavailable on the iOS simulator and background `URLSession` events are unreliable there. Android emulator: first frames can drop (already handled) and hosts resolve via `10.0.2.2`. Test on devices. |
| 11 | Concurrency | Always a fresh UUID per session (then `overwrite: true` is safe); two handles writing one file race at the same offset. |
| 12 | Foreground-only today | `shouldPlayInBackground: false` and no `enableBackgroundRecording`; enabling it later adds the iOS `audio` mode and an Android recording foreground service (persistent notification, battery cost). |
| 13 | Web | `expo-file-system`'s `File` API is native-only; the web path should skip the tee (or use OPFS/IndexedDB) rather than shimming it. |

## Sources

- Expo SDK 57 FileSystem docs (File/FileHandle/FileMode/UploadOptions/`sessionType`) — https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/
- Expo SDK 57 Audio docs (`AudioStream`, `onBuffer`, `AudioStreamBuffer`) — https://docs.expo.dev/versions/v57.0.0/sdk/audio/
- expo-audio sdk-57 iOS tap buffer (`sampleRate * 0.1`) — https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/ios/AudioStream.swift
- expo-audio sdk-57 Android capture loop (`DEFAULT_BUFFER_DURATION_MS = 100`) — https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/android/src/main/java/expo/modules/audio/AudioStream.kt
- expo-audio `main` `startFileRecordingAsync` (SDK 58, not in 57) — https://github.com/expo/expo/blob/main/packages/expo-audio/src/AudioStream.types.ts
- expo-file-system sdk-57 iOS FileHandle (`FileHandle(forWritingTo:)`, append/truncate) — https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemFileHandle.swift
- expo-file-system sdk-57 Android FileHandle (`RandomAccessFile`, append via position) — https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/android/src/main/java/expo/modules/filesystem/FileSystemFileHandle.kt
- expo-file-system sdk-57 iOS upload task + `NetworkTaskSessionManager` (background URLSession, stable identifier, `sessionSendsLaunchEvents`) — https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemUploadTask.swift and https://github.com/expo/expo/blob/sdk-57/packages/expo-file-system/ios/FileSystemDownloadTask.swift
- Expo BackgroundTask docs (WorkManager/BGTaskScheduler, 15-minute floor, kill semantics) — https://docs.expo.dev/versions/v57.0.0/sdk/background-task/
- “Goodbye background-fetch, hello expo-background-task” — https://expo.dev/blog/goodbye-background-fetch-hello-expo-background-task
- Slow iOS background upload reports (expo-file-system) — https://github.com/expo/expo/issues/26754
- “Build a React Native video upload that survives backgrounding…” (2026; `react-native-background-upload` fallback, Android FGS limits) — https://dev.to/masonwritescode/build-a-react-native-video-upload-that-survives-backgrounding-app-kills-and-cellular-36b6
- Apple `background(withIdentifier:)` (suspended/terminated transfers; force-quit cancels) — https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background(withidentifier:)
- Apple Data Protection classes (default Class C for third-party app data) — https://support.apple.com/guide/security/data-protection-classes-secb010e978a/web
- Android Auto Backup (25 MB per app; `filesDir` included) — https://developer.android.com/identity/data/autobackup
- Android foreground-service timeouts (`dataSync` 6 h/24 h) — https://developer.android.com/develop/background-work/services/fgs/timeout
- Android data-transfer options (WorkManager vs foreground service, 10-minute workers) — https://developer.android.com/develop/background-work/background-tasks/data-transfer-options
- Vercel Blob client uploads (`handleUpload`, `onBeforeGenerateToken`, `validUntil`) — https://vercel.com/docs/vercel-blob/client-upload
- Vercel 4.5 MB function body limit — https://vercel.com/kb/guide/how-to-upload-and-store-files-with-vercel
- `@vercel/blob` client PUT protocol (URL `https://vercel.com/api/blob/?pathname=…`, `authorization`, `x-api-version: 12`, `x-content-type`, `x-vercel-blob-access`) — https://github.com/vercel/storage/blob/f23cb891/packages/blob/src/api.ts and https://github.com/vercel/storage/blob/f23cb891/packages/blob/src/put-helpers.ts
