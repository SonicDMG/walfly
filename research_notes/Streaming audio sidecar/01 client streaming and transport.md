# 01 — Client capture & streaming to the FastAPI sidecar

Scope: how the Walfly client (Expo web first, then iOS/Android, plus Bee Pioneer BLE) should capture audio and stream it continuously to `packages/api/sidecar/transcribe_sidecar.py` on Fly.io, so the sidecar owns VAD/chunking/transcription. Grounded in the current code at `apps/mobile/lib/webRecorder.ts`, `apps/mobile/hooks/useRecordingUpload.ts`, `apps/mobile/lib/chunkQueue.ts`, `apps/mobile/hooks/useBeePioneerRecorder.ts`, `apps/mobile/lib/beePioneer.ts`, `apps/mobile/lib/beeProtocol.ts`.

> **TL;DR**
> 1. **Transport: one WebSocket per recording session, `wss://<sidecar>.fly.dev/ws/transcribe`, binary frames.** Terminate the WS on the **Fly sidecar directly**, never on Vercel/Next (Vercel WS exists in beta but caps functions at 300 s default / 800 s max — shorter than one 15-min recording). Mint a short-lived token in the Next API, present it in a `hello` control message.
> 2. **Wire format: 8-byte binary header `[seq u32][t_ms u32]` + payload; JSON text frames for control only.** Codec negotiated in `hello`: `pcm_s16le` for phone mics (web AudioWorklet, native `expo-audio` `useAudioStream`), `aac_adts` passthrough for Bee. PCM at 16 kHz mono = 32 kB/s; Opus/AAC ≈ 3–4 kB/s. Frames batched every **100 ms (3,200 B PCM)**.
> 3. **Native capture is solved first-party:** `expo-audio` ≥ 56.0.0 ships `useAudioStream()` — "a native audio stream that captures PCM audio from the microphone in real-time", with `onBuffer({data: ArrayBuffer, sampleRate, channels, timestamp})`, `encoding: 'int16' | 'float32'`. You are on `expo-audio ~57.0.4` ([docs](https://docs.expo.dev/versions/latest/sdk/audio/), [changelog](https://github.com/expo/expo/blob/sdk-57/packages/expo-audio/CHANGELOG.md)). No third-party audio module needed.
> 4. **Keep `chunkQueue.ts` as the fallback path.** Streaming is primary; on sustained socket failure or backgrounding that kills capture, fall back to the existing file-chunk upload. This is Walfly's existing resilience superpower and should not be deleted in the redesign.

---

## 1. Transport

| Option | Web | RN / Expo | Reconnect/resume | Proxy reality | Verdict |
|---|---|---|---|---|---|
| **WebSocket binary** | Native, worklet → WS | Native `WebSocket` (built-in, no native module); accepts `ArrayBuffer` | Explicit, easy (`seq` + resume token) | Passes Fly proxy, Cloudflare (needs keepalive ≤100 s idle) | ✅ **Chosen** |
| HTTP/2 chunked POST (streaming body) | Only with `duplex:'half'`; response unreadable until upload ends | **Request bodies are buffered**: `expo/fetch` "drains it into one buffer before the request starts" ([oRPC adapter docs](https://orpc.dev/docs/adapters/expo)); classic RN fetch cannot stream bodies ([axios#6375](https://github.com/axios/axios/issues/6375)) | Resume = re-POST with offset (doable) | Middleboxes may buffer; no server→client control channel | ❌ |
| WebRTC | Possible; heavy | `react-native-webrtc` native module + config plugin | ICE restart, but you need signalling + TURN | UDP/DTLS usually fine | ❌ Needs SFU/TURN + PCM extraction server-side for Whisper; buys nothing for one-way capture |
| gRPC (grpc-web / RN grpc) | No client-streaming in browsers by spec | Native module, protobuf toolchain, second server stack beside FastAPI | Manual | Needs Envoy/connect proxy | ❌ |
| SSE | Server→client only | Same | — | — | ❌ cannot upload audio |

**Why WS wins here:** it is the only transport that (a) genuinely streams request-side bytes from both browsers and React Native, (b) gives a bidirectional control channel for acks/resume/partial transcripts without a second connection, and (c) is a built-in primitive on both platforms — no native modules, no signalling, no TURN. It is also the pattern every production STT vendor converges on (Deepgram, AssemblyAI Universal-Streaming, WhisperLive, ufal/whisper_streaming are all WS-first; [WhisperLive](https://github.com/collabora/WhisperLive), [whisper_streaming](https://github.com/ufal/whisper_streaming)).

**Hosting:** Fly.io proxies WS fine ([Fly's own WS blog](https://fly.io/blog/websockets-and-fly/)); set `min_machines_running = 1` during pilot so the first connection doesn't eat a Fly cold start (client connect timeout ≥ 15 s, then retry). Vercel now serves WebSockets natively in public beta, but connections "pin to an instance" and inherit function duration limits — Pro default 300 s, max 800 s, extended 1800 s in beta ([Vercel KB](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)). A 15-minute walk recording would be severed mid-stream; keep the Next API for session/auth/finalize and stream to Fly.

**Idle keepalive:** Cloudflare closes proxied WebSockets after ~100 s without traffic on Free/Pro (not configurable; [Cloudflare community](https://community.cloudflare.com/t/cloudflare-websocket-timeout/5865), [websocket.org guide](https://websocket.org/guides/infrastructure/cloudflare/)). Audio frames every 100 ms avoid this while capturing; add an app-level `ping` every 10–15 s for muted/backgrounded stretches (browser WS cannot send protocol pings; RN has a non-standard `ws.ping()` in [RN's source](https://github.com/facebook/react-native/blob/main/packages/react-native/Libraries/WebSocket/WebSocket.js), but don't rely on it cross-platform).

---

## 2. Wire format

### Bandwidth at 16 kHz speech (mono)

| Codec | Bitrate | Bytes/s | 15-min session | Client CPU | Sidecar decode |
|---|---|---|---|---|---|
| PCM s16le 16 kHz | 256 kbps | 32,000 | 28.8 MB | ~0 (memcpy) | none (needs 16 kHz only) |
| Opus WB speech | 16–20 kbps (RFC "sweet spot") | ~2,000–2,500 | ~1.8–2.2 MB | encoder needed | libopus / Ogg-in-libsndfile |
| ADTS AAC (Bee) @32 kbps | 32 kbps | ~4,000 | ~3.6 MB | **zero — device already encodes** | ffmpeg/PyAV AAC decode |

PCM figures: 16,000 samples/s × 2 B. Opus wideband speech sweet spot 16–20 kbit/s per [RFC 6716 §2.1.1](https://datatracker.ietf.org/doc/html/rfc6716#section-2.1.1). AAC-ADTS frames carry 1,024 samples (64 ms at 16 kHz; the app already assumes this in `useBeePioneerRecorder.ts`).

**Firm choice: PCM as the v1 mic codec, ADTS passthrough for Bee.** Rationale: PCM makes the sidecar maximally simple (append → optional resample → Silero VAD → Whisper; no decoder, no container surgery, no per-frame discontinuity handling) and every client path can produce it natively at zero encoding cost. 28.8 MB per 15-min session is real but bounded, and the phone path is the *manual* path — the all-day passive path is Bee, which already streams at ~4 kB/s without the phone decoding anything. Compressed mic audio (Opus via WebCodecs or MediaRecorder segments) is documented as a later bandwidth optimization, not a v1 requirement. **Do not send base64-in-JSON** (OpenAI-Realtime style): +33 % bytes and string churn; Deepgram/AssemblyAI/WhisperLive all accept raw binary frames, and so should we.

### Handshake & framing sketch

Control = JSON **text** frames. Audio = **binary** frames. The `hello` establishes everything the sidecar needs to run a decoder-free PCM path:

```jsonc
// client -> server (text), immediately after accept
{ "t": "hello",
  "sessionId": "0d6c…",            // same id used with /api/recordings/session
  "token": "<JWT, 60s TTL, scoped to sessionId>",
  "codec": "pcm_s16le",            // | "aac_adts" (Bee)
  "sampleRate": 16000,             // ACTUAL capture rate (see §3)
  "channels": 1,
  "clientClockMs": 1760000000000,  // epoch at stream start, for wall-clock anchoring
  "resume": { "fromSeq": 412 }     // omit on first connect
}

// server -> client (text)
{ "t": "ready", "sessionId": "…", "resumeFrom": 412 }
{ "t": "error", "code": "auth", "message": "…" }   // then close 4401

// server -> client (text), ~1 Hz
{ "t": "ack", "seq": 431 }         // highest contiguous frame seq stored

// both directions
{ "t": "ping", "t0": 1760000001234 }   // client every 10-15s when no audio flowing
{ "t": "pong", "t0": 1760000001234 }

// client -> server before clean close
{ "t": "bye", "reason": "user_stop", "lastSeq": 900 }
```

Binary frame layout (little-endian, 8-byte header):

```
offset 0  uint32  seq        per-session, starts at 0, +1 per frame
offset 4  uint32  t_ms       stream-relative capture time of first sample
offset 8  bytes   payload    PCM s16le (or one-or-more whole ADTS frames)
```

Rules the server implements: append payload to the session spool; drop `seq ≤ lastContiguous`; reorder-buffer the small window above it; `ack` highest contiguous; resample only if `sampleRate ≠ 16000`; for PCM derive timestamps from **cumulative sample counts** (`t_ms`/`clientClockMs` only anchor wall-clock). Cap payload at 16 KB (250 ms @16 kHz); 100 ms/3,200 B is the default, matching Deepgram's "100 ms = 3,200 bytes at 16 kHz mono" guidance ([Deepgram](https://deepgram.com/learn/nodejs-voice-ai-production-guide), [overview](https://deepgram.com/learn/streaming-speech-recognition-api)) and inside AssemblyAI's 50–1,000 ms window ([Universal-Streaming](https://www.assemblyai.com/docs/voice-agents/best-practices)). Uvicorn defaults fit: `--ws-max-size` 16 MiB, 20 s ping interval/timeout ([uvicorn settings](https://www.uvicorn.org/settings/)).

---

## 3. Per-platform capture (2025/2026 reality)

### Web (first target)

Primary: `getUserMedia` → **AudioWorklet** PCM tap. Post 128-sample `Float32` render quanta; batch to 100 ms on the main thread; convert to `Int16Array`; `ws.send(buf)`. Two ways to get 16 kHz:

- **Preferred:** `new AudioContext({ sampleRate: 16000 })` — supported in Chromium/Safari; the browser resamples natively. Verify `ctx.sampleRate` after construction and report it in `hello`.
- **Firefox caveat:** custom `sampleRate` + `getUserMedia` is a known mismatch bug ([mdn/browser-compat-data#16213](https://github.com/mdn/browser-compat-data/issues/16213)); keep the default rate and decimate in the worklet with a `BiquadFilterNode` low-pass (~7.5 kHz) before the worklet tap plus simple decimation. Server-side resample is the final safety net either way.

MediaRecorder timeslices (Opus) **can** be forwarded — `webRecorder.ts` already runs MediaRecorder with a timeslice and segment rotation — but blobs after the first are continuation fragments, not independent streams: the sidecar would need incremental WebM/MP4 demuxing (plus per-segment timestamp restarts under the 15 s rotation). Cheaper compromise if bandwidth ever matters: reuse `startWebRecording()` with a 2–5 s `chunkIntervalMs` and forward each **self-contained segment** for PyAV/ffmpeg decode. Keep as fallback; don't build v1 on it. WebCodecs `AudioEncoder('opus')` is the clean future upgrade (Chromium solid; feature-detect per [caniuse](https://caniuse.com/webcodecs)) and slots in as `codec: "opus"` with no protocol change.

```ts
// web: worklet posts Float32 chunks; main thread batches to 100ms and sends
worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
  pcmQueue.push(e.data); pcmSamples += e.data.length;
  while (pcmSamples >= 1600) {                     // 100 ms @16 kHz mono
    const payload = dequeueInt16(1600);            // Int16Array(1600) -> 3200 bytes
    sendFrame(seq++, tms(), payload);              // 8-byte header + payload
  }
};
```

### React Native / Expo (SDK 57 in this repo)

Use `expo-audio`'s **`useAudioStream`** (`AudioStream`), added in expo-audio **56.0.0** and present in the 57.x you already depend on. It delivers `AudioStreamBuffer { data: ArrayBuffer; sampleRate; channels; timestamp }` with `encoding: 'int16' | 'float32'` — exactly the wire format. Request `sampleRate: 16000, channels: 1, encoding: 'int16'`; read back `stream.sampleRate` (docs: actual rate may differ) and put the **actual** rate in `hello`.

```ts
const { stream } = useAudioStream({
  sampleRate: 16000, channels: 1, encoding: 'int16',
  onBuffer: (b) => streamer.push(new Uint8Array(b.data)),  // batch to 100ms, sendFrame()
});
await AudioModule.requestRecordingPermissionsAsync();
await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }); // + background if needed
await stream.start();
```

Caveats: expo-audio docs also list Web support for `AudioStream`, but that is young — verify on web, keep the custom AudioWorklet path as the web implementation. Background capture requires the `expo-audio` config plugin: `enableBackgroundRecording: true` (Android: `FOREGROUND_SERVICE_MICROPHONE` + `POST_NOTIFICATIONS` + persistent notification; iOS: `audio` background mode) plus `setAudioModeAsync({ allowsBackgroundRecording: true })` ([expo-audio docs](https://docs.expo.dev/versions/latest/sdk/audio/)). Android 14 makes the FGS type mandatory and mic FGS requires the while-in-use `RECORD_AUDIO` grant ([Android docs](https://developer.android.com/about/versions/14/changes/fgs-types-required)); without an FGS, Android 11+ cuts the mic when backgrounded.

If `AudioStream` disappoints: **react-native-audio-api** (Software Mansion) has microphone capture ("grab audio data from device microphone… or stream through the internet"), AudioWorklet, and recording rotation, MIT-licensed, actively released (0.13.6, Oct 2026; [repo](https://github.com/software-mansion/react-native-audio-api)) — heavier, native-only, needs a dev build. **`@siteed/audio-studio`** (MIT, active, built-in VAD + PCM streaming) is the other credible option. **`react-native-live-audio-stream` is dead** (last publish May 2022, [npm](https://www.npmjs.com/package/react-native-live-audio-stream)) — do not adopt. Read-tailing the recorder file is unacceptable latency and battery complexity.

### Bee Pioneer (already-framed ADTS AAC)

The BLE path changes **nothing about the transport** and everything about the codec decision: `beeProtocol.ts` already yields complete ADTS frames (`AdtsFramer`), and decoding AAC on the phone to re-send PCM would be pure battery burn. Forward complete ADTS frames in the same binary frame envelope with `codec: "aac_adts"` — group one BLE notification's frames (or ~100 ms worth) per WS frame. The sidecar needs a Python port of `AdtsFramer` (resync-capable; ~60 lines, port verbatim from `beeProtocol.ts`, including the "frame length < 7 ⇒ false sync, skip one byte" rule) and an incremental AAC decoder (PyAV/ffmpeg reading an ADTS elementary stream from a pipe → s16le 16 kHz). Note BLE notifications can fragment a frame or deliver several; the client's existing framer already handles this — keep it and don't decode.

---

## 4. Reliability & resume

- **Session identity:** the client already creates a session id and registers it via `POST /api/recordings/session` (`useRecordingUpload.ts`). Keep that as the source of truth; the sidecar keys all state by `sessionId`. Reject a second concurrent stream on the same id (close 4409) and expire idle state after ~2× max recording duration.
- **Server state:** append-only PCM/AAC spool per session + `lastContiguousSeq` + small out-of-order map + VAD/segmenter state. Resume costs nothing because append is idempotent once seq is deduped.
- **Client buffer:** bounded FIFO of unacked frames, **≥30 s** (30 s of PCM = 960 KB — hold 60 s, ~1.9 MB). Trim on `ack`. On native, optionally spill to a cache file (reuse the `chunkQueue` file conventions) if the buffer crosses 30 s; on web accept loss.
- **Reconnect:** on close/error/pong-timeout, reconnect with jittered backoff (0.5→8 s, cap 15 s), send `hello` with `resume.fromSeq = lastAck+1`, flush the buffer. Dead-socket detection: no `ack` and no `pong` for 5 s ⇒ close deliberately (browsers can take minutes to notice a dead TCP path otherwise). Also react to `online`/`offline` and `visibilitychange` on web.
- **Backpressure:** portable rule — if the oldest unacked frame is >5 s old, or the local send queue exceeds 5 s, stop enqueueing and mark a gap. Do **not** use `bufferedAmount`: RN's `WebSocket` declares it but never updates it ([RN source](https://github.com/facebook/react-native/blob/main/packages/react-native/Libraries/WebSocket/WebSocket.js)); ack-lag is the cross-platform signal. RN's binary `send()` crosses the bridge as base64 internally (`binaryToBase64`, same source) before going out as true binary — fine at ~10 frames/s, another reason not to exceed 100 ms batching.
- **Failure ladder:** WS degraded >60 s → keep recording and push segments through the existing `chunkUploadQueue` (file chunks to Next → sidecar), then `/finalize`. Preserves today's "never lose a walk" property; the sidecar must tolerate streamed-prefix + uploaded-tail for one session, or the fallback starts a fresh recording id.
- **Ordering/clocks:** seq handles dedupe/ordering; never trust wall-clock for alignment (device clocks jump; sample-clock drift ~0.1 %). Use cumulative samples for segment times, `clientClockMs` only to map to epoch.

---

## 5. Battery / CPU budget

- PCM capture + WS send: negligible CPU (no codec). The dominant cost is radio duty cycle — continuous 256 kbps keeps the radio awake either way, so Opus's win is mostly *bytes* (metered data), not battery. Bee passthrough is the real battery win: zero phone decode/encode.
- Keep work off the web main thread (worklet → batch → send); avoid `SharedArrayBuffer` unless you add COOP/COEP headers — `postMessage` at 10 msgs/s is cheap enough.
- Don't gate silence on the client: server-side VAD needs silence to close utterances. (For any future all-day phone capture, revisit with Opus DTX, not client VAD.)
- Assert server-side in CI: `frames_sent × 100 ms ≥ recording duration` to catch silent-capture regressions (this codebase has been bitten by exactly that class of bug).

## 6. Gotchas table

| # | Gotcha | Impact | Mitigation |
|---|---|---|---|
| 1 | Vercel WS sessions die at 300–800 s | Long recordings severed | Terminate WS on Fly sidecar only |
| 2 | Cloudflare 100 s WS idle timeout (custom domain, orange cloud) | Mid-recording drops on quiet stretches | Audio every 100 ms + app-level ping ≤15 s |
| 3 | Firefox `AudioContext({sampleRate})` + getUserMedia mismatch bug | Wrong-rate or silent capture | Default-rate ctx + biquad lowpass + decimate; report actual rate |
| 4 | Android 11+ mic blocked in background without mic-typed FGS; Android 14 requires the type | Capture dies when screen locks | `enableBackgroundRecording` plugin + `allowsBackgroundRecording` mode |
| 5 | iOS interruptions (calls, Siri), `mediaServicesDidReset`, BT-route disconnects | Stream stops/resets mid-session | Handle interruption/route events, recreate `AudioStream`, `keepAudioSessionActive` if available; reconnect WS |
| 6 | Web background tab throttling/freezing | Frames stall; MediaRecorder already observed halting (`webRecorder.ts` header) | `visibilitychange` handling; fallback to file chunks; resume on `fromSeq` |
| 7 | RN `bufferedAmount` never updated; RN `send()` base64-hops across bridge | No native backpressure signal; CPU on large frames | Ack-lag backpressure; ≤100 ms frames |
| 8 | Uvicorn server pings every 20 s / timeout 20 s | Server may drop clients that don't auto-pong | Verify both native stacks pong (OkHttp/NSURLSession do); keep app ping too |
| 9 | Base64-in-JSON temptation | +33 % bytes, CPU | Binary frames; JSON only for control |
| 10 | Device clock jumps | Bad timestamps | Sample-count timestamps; wall clock only via `clientClockMs` |
| 11 | Fly cold start / `auto_stop_machines` | First connect slow, drops look like errors | `min_machines_running=1` in pilot; 15 s connect timeout |
| 12 | ADTS resync after BLE packet loss | Permanent silence if framer wedges | Port `AdtsFramer` rules verbatim to Python |
| 13 | WS message > server limit / IP fragmentation | Rare with 3.2 KB frames | Cap payload 16 KB; uvicorn default is 16 MiB |
| 14 | Duplicate concurrent streams for one session | Corrupted spool | Close 4409 on second stream |

## 7. Alternatives considered (and why not)

- **WebRTC/LiveKit-style:** adds native modules, signalling, TURN, and still needs PCM extraction for Whisper — right answer for *interactive* duplex, wrong for one-way capture.
- **gRPC:** browser client-streaming unsupported; duplicate stack next to FastAPI.
- **HTTP/2 streaming POST:** RN buffers request bodies (fatal); loses the server→client control channel.
- **Opus-on-web now:** WebCodecs encoder support is uneven (feature-detect per [caniuse](https://caniuse.com/webcodecs)); MediaRecorder-opus requires container reassembly. Deferred, protocol-ready.
- **Sending float32 instead of int16 PCM:** no quality gain for Whisper, 2× bytes.
- **Client-side VAD/chunking:** explicitly out of scope — moving it server-side is the redesign's point.

## 8. Open questions

1. **Finalize contract:** today the client POSTs `/finalize` after chunks drain; with continuous streaming, who declares end-of-session — the `bye` message, the Next `/finalize` (still useful for crash recovery via the localStorage orphan sweep), or both? The sidecar's segment→transcription handoff to Next's pipeline `/process` loop needs a decided contract.
2. Does the sidecar need `partial` transcript events for UI (live captions), or is streaming purely for segmentation quality? Protocol has room; UI doesn't consume it yet.
3. Resampling library on the sidecar (`soxr`/`scipy.signal.resample_poly`) and AAC decode path (PyAV vs ffmpeg subprocess) — affects the Fly VM size.
4. Single Fly process serving WS + existing docling HTTP endpoints: confirm uvicorn workers=1 is acceptable (in-memory session state) and measure Whisper CPU contention with concurrent streams.
5. Web: verify `expo-audio` `AudioStream` on web vs custom AudioWorklet; and whether Safari iOS web should even stream (28.8 MB/session on cellular) or fall back to periodic file uploads.
6. Auth token shape/TTL for `hello` (JWT minted by Next, single-use?) and whether the sidecar validates against a shared secret or a Next introspection endpoint.
