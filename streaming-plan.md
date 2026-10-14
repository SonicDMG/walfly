# Walfly — Streaming Audio Architecture

> **Status:** design + phase-1 implementation (`feat/streaming-sidecar`, branched
> from `main`). Supersedes the client-chunked live-session design described in
> `research_notes/Streaming audio sidecar/00 current live session flow map.md`.
>
> Research inputs: `research_notes/Streaming audio sidecar/01…04`. This document
> is the decided design; the research notes hold the evidence and the
> alternatives considered.

## 1. How it works (target)

- The UI captures audio and **streams it continuously over one WebSocket** to the
  Python sidecar. No client-side chunking, no client-side VAD, no per-chunk
  uploads.
- The **sidecar owns segmentation**: Silero VAD + a segmenter decide what is an
  utterance; a LocalAgreement-2 loop emits growing partials and immutable
  `segment` finals with session-clock timestamps.
- The client **checkpoints every finalized segment** to the Next.js API
  (`POST /api/recordings/{id}/segments`), then ACKs it to the sidecar. Acked ⇒
  durable in Astra. The sidecar keeps a short unacked replay ring for reconnects.
- On stop the client calls `/finalize`; the existing resumable pipeline
  (`uploaded → enriching → ready`) runs unchanged, then LLM enrichment produces
  the summary, action items and insights (phase 2 adds the live rolling view).

```
Expo client                          Next.js API (Vercel)                 Fly sidecar
───────────                          ────────────────────                 ───────────
POST /api/recordings/session ──────► createLiveSession (Astra)
POST …/{id}/ws-ticket ─────────────► mint HMAC ticket
wss://…/v1/stream  (subprotocol: walfly.v1, ticket.…)
  hello → ready
  ── binary PCM frames (8B header + s16le) ──────────────►  reader → bounded queue
                                                              │
  ◄── partial {revision, text, tEnd}  (UI captions)           ▼
  ◄── segment {seq, startMs, endMs, text} ◄──── VAD + worker pool (faster-whisper)
  POST …/segments {chunkIndex, startMs, endMs, text} ──► recordSegment (Astra)
  ── ack {seq} ─────────────────────────────────────────► trim replay ring
  bye / stop
  ◄── final {lastSeq}, close 1000
POST …/{id}/finalize ──────────────► status=uploaded
POST …/{id}/process (ticks) ───────► pipeline: transcript → enrich (LLM) → ready
```

Key invariants (unchanged from the existing design): no background jobs, no
detached promises, client-driven ticks, one durable doc per recording.

## 2. Decisions

| Decision | Choice | Why (detail in research notes) |
|---|---|---|
| Transport | One WebSocket per session, terminated on the Fly sidecar (`wss://…/v1/stream`) | Only transport that truly streams from browsers *and* RN; Vercel WS caps at 300–800 s; HTTP chunked bodies are buffered by `expo/fetch` (01) |
| Wire codec | PCM s16le 16 kHz mono, 100 ms / 3.2 KB binary frames with 8-byte header `[seq u32][t_ms u32]` | Zero client encode cost; sidecar needs no decoder; protocol has `codec` field so Bee ADTS AAC passes through later (01) |
| Client capture — web | `getUserMedia` + AudioWorklet PCM tap, batched to 100 ms | Worklet keeps capture off the main thread; Firefox sample-rate bug handled per 01 §3 |
| Client capture — native | `expo-audio` `useAudioStream()` (`encoding: 'int16'`) | First-party since expo-audio 56; the repo is on 57.0.4 — no third-party module (01) |
| VAD | Silero v6 ONNX from **faster-whisper's vendored asset** + own segmentation state machine | Torch-free (`faster_whisper.vad.SileroVADModel`); hysteresis + min-speech gate + 800 ms cut + 25 s forced cut (02 §1) |
| ASR | faster-whisper, LocalAgreement-2: partials beam 1 T=0, finals beam 5 + fallback ladder; `condition_on_previous_text=False`, `initial_prompt` = ≤150-char committed tail | 02 §2–4. CPU v1: `small.en` int8. Model/compute configurable by env |
| Chunking owner | The sidecar. Clients never segment or gate silence | The redesign's point |
| Checkpointing | Client posts each final `segment` to `POST /api/recordings/{id}/segments` (idempotent upsert), then ACKs; sidecar replays unacked ring on reconnect | Preserves "no credentials in the sidecar", keeps Astra writes in one place, crash loses ≤ 1 in-flight segment (04) |
| Auth | HMAC-SHA256 ticket minted by Next (`/ws-ticket`, TTL 120 s, single-use nonce, bound to recording id), carried in `Sec-WebSocket-Protocol` as `ticket.<b64url>` | Browser WS can't set headers; query tokens leak into logs; cookies unreliable on iOS (04) |
| Enrichment | Stays in the Next.js API; final pass unchanged in phase 1. Phase 2 adds `POST /{id}/live` rolling updates (ops-based, quote-grounded) | User decision + 03 |
| Old pipeline | **Deleted** (client chunking, per-chunk ASR, `/chunks`, chunk queue, client VAD assets) | User decision. Consequence accepted: when the sidecar is unreachable, recording is unavailable until it returns — noted as follow-up in §9 |
| Deployment | Same sidecar service, updated: 4 vCPU / 4 GB floor (8 GB comfortable), `min_machines_running=1`, `auto_stop_machines="stop"`, `kill_timeout=60`, uvicorn `workers=1` | 04 §Deployment. Fly GPUs are EOL; Groq is the quality escalation path |

## 3. Wire protocol v1

Endpoint `GET /v1/stream` (WebSocket upgrade). Subprotocols offered by the
client: `["walfly.v1", "ticket.<base64url>"]`; server accepts `walfly.v1`.

Control = JSON text frames. Audio = binary frames. Binary layout (little
endian): `uint32 seq | uint32 t_ms | payload` where `seq` starts at 0 per
session epoch and `t_ms` is the stream-relative capture time of the first
sample (informational; the server derives authoritative times from cumulative
sample counts).

Client → server:

```jsonc
{ "t": "hello", "sessionId": "…",          // must match the ticket's recording id
  "codec": "pcm_s16le", "sampleRate": 16000, "channels": 1,
  "clientClockMs": 1760000000000,
  "resume": { "fromSeq": 412 } }            // omitted on first connect
{ "t": "ack", "seq": 431 }                  // highest POSTed-to-API segment
{ "t": "ping", "t0": 1760000001234 }        // every ≤15 s when no audio flows
{ "t": "bye", "lastSeq": 900 }              // clean stop
```

Server → client:

```jsonc
{ "t": "ready", "sessionId": "…", "sampleRate": 16000, "codec": "pcm_s16le",
  "resumedFromSeq": 412 }
{ "t": "partial", "revision": 7, "tEnd": 18.4, "text": "…" }   // grows only
{ "t": "segment", "seq": 7, "chunkIndex": 7, "start": 12.1, "end": 18.4,
  "text": "…", "avgLogprob": -0.31 }
{ "t": "ack", "seq": 431 }                  // server ack of received audio frames
{ "t": "flow", "lagMs": 15200, "limitMs": 30000 }   // backpressure advisory
{ "t": "gap", "fromMs": 60000, "toMs": 65000 }      // dropped audio, explicit
{ "t": "final", "lastSeq": 900 }
{ "t": "error", "code": "auth|protocol|internal", "message": "…" }
```

Rules:

- Times on the wire are float **seconds on the session clock**
  (`samples_received / sample_rate`). Segment events carry seconds; the API
  stores milliseconds (`offsetMs = start * 1000`, `duration = end - start`).
- `partial` streams only the committed prefix (LA-2) — it never shrinks within
  a revision; drop out-of-order revisions client-side.
- `segment` finals are immutable and strictly ordered by `seq`.
- Resume: after reconnect, `hello.resume.fromSeq = lastAckedSeq + 1`; the server
  replays unacked segments (`seq > lastAckedSeq`) from its ring, then continues.
  If the session is unknown (different machine, TTL expired) the server emits
  `ready` with `reset: true`; the client derives its next `chunkIndex` from
  locally persisted state and continues — a gap in audio, never a crash.
- Backpressure: client counts **ack-lag** (oldest unacked frame). > 5 s: stop
  enqueueing, mark a local gap. Server high-water at 15 s sends `flow`; at 30 s
  it drops oldest audio and emits `gap`; at 60 s it closes 1013.
- Keepalive: client `ping` every ≤15 s when audio is not flowing; server closes
  4408 after 45 s of silence; server protocol pings at 20 s (uvicorn defaults).
- Close codes: 1000 clean, 1013 overloaded, 4401 auth, 4408 hello/idle timeout,
  4409 duplicate concurrent stream for one session.
- Limits: max frame 32 KB (payload ≤ 16 KB), max session 4 h, then forced final.

## 4. Sidecar internals

Torch-free by construction: `faster-whisper` (ctranslate2 + onnxruntime + PyAV)
only. Docling is dropped.

### 4.1 VAD + segmentation (02 §1, §4)

Silero v6 ONNX (from `faster_whisper`'s vendored asset) on 512-sample / 32 ms
windows with per-session `(h, c)` state:

- start threshold 0.5 (confirm after 2 frames), end threshold 0.35 (hysteresis)
- min speech 250 ms; a segment only *opens* at ≥ 1.0 s of speech
- 800 ms of sub-threshold frames closes a segment (cut at the silence midpoint)
- pre-roll 300 ms, post-roll 400 ms
- forced cut at 25 s of speech, placed at the quietest 100 ms frame in the last 3 s
- 0.5 s overlap only at forced cuts; boundary words deduped by word-timestamp
  rule + `difflib.SequenceMatcher` suffix/prefix alignment
- music/noise guard: sustained loud non-speech does not reach ASR because of the
  min-speech gate; drop-verbatim-duplicate and blocklist guards on finals

### 4.2 ASR loop (02 §3–4)

- Session ring buffer (≤ 45 s float32 @16 kHz); server clock = cumulative samples.
- Partial decode every ≥ 0.8 s of new speech (adaptive up to 2 s when a decode
  overruns), **left-trimmed at the last committed word** — the single biggest
  CPU lever (02 §6). beam 1, T=0, no word timestamps.
- Commit via LocalAgreement-2 (common word prefix of the last two hypotheses).
- Final decode at segment close: beam 5 + temperature fallback ladder, word
  timestamps on, hallucination guards (`no_speech_threshold=0.6`,
  `log_prob_threshold=-1.0`, `compression_ratio_threshold=2.4`, verbatim-repeat
  and blocklist filters).
- Context: `condition_on_previous_text=False` always; `initial_prompt` = tail of
  committed text (≤150 chars, timestamps stripped).

### 4.3 Process model (04 §Process)

- **One uvicorn process** (`workers=1` is load-bearing; in-memory sessions).
- WS reader is asyncio; audio goes into a per-session bounded `queue.Queue`
  (30 s cap). A per-session processor thread consumes frames: VAD, ring,
  scheduling. A shared pool of **N worker threads, each owning its own
  `WhisperModel` instance** (ctranslate2 calls are single-flight), executes
  decodes; partial jobs are latest-wins (max depth 1), finals always run and
  preserve order. All socket writes go through one writer task per session.
- Nothing CPU-bound runs on the event loop. `OMP_NUM_THREADS` and per-model
  `cpu_threads` are set so `instances × cpu_threads ≤ vCPUs`.
- Graceful shutdown: SIGTERM → DRAINING → sessions flush in-flight spans →
  `final` → close 1000, bounded by `kill_timeout=60`.
- Metrics/logs: one JSON line per lifecycle event (no transcript text),
  `/metrics` (token-gated) with `active_sessions`, `queue_lag_seconds`,
  `rtf`, `partial_latency_ms`, `gap_ms_total`, `model_load_seconds`.

### 4.4 File path (kept, rewritten)

`POST /v1/transcribe` (multipart) keeps its exact response contract
(`{"markdown": "…"}` with `[time: m:ss.s-m:ss.s] lines`) so the non-live
`/api/recordings/upload → pipeline` path keeps working, but is now powered by
faster-whisper (`transcribe()` with word timestamps + the same markdown
formatter). The dead docling-style async trio
(`/v1/convert/file/async`, `/v1/status/poll`, `/v1/result`) is deleted.

### 4.5 Config (env)

`ASR_MODEL` (default `small.en`), `ASR_DEVICE` (`cpu`), `ASR_COMPUTE_TYPE`
(`int8`), `ASR_WORKERS` (default 2), `ASR_CPU_THREADS` (default 2),
`WALFLY_WS_SECRET`, `SIDECAR_PORT`, `ALLOWED_ORIGINS`, `METRICS_TOKEN`.
Local dev on Apple Silicon: `ASR_MODEL=tiny.en` (or `base.en`) keeps iteration
fast; production bakes `small.en` into the image.

## 5. API integration

### 5.1 `POST /api/recordings/{id}/ws-ticket` (new)

Returns `{ ticket, url, expiresAt }`. Ticket =
`base64url(HMAC_SHA256(WALFLY_WS_SECRET, sessionId|exp|nonce))` with the payload
alongside (`v1.<exp>.<nonce>.<sig>`) so the sidecar can validate statelessly.
`url` is built from `SIDECAR_WS_URL` (default `ws://localhost:8888/v1/stream`).
404 if the recording does not exist.

### 5.2 `POST /api/recordings/{id}/segments` (new; replaces `/chunks`)

JSON body `{ chunkIndex, startMs, endMs, text }`. Validates the recording is a
live session in `recording`/`uploaded`, clamps text, upserts the segment doc
(same collection + idempotent `_id` scheme as before), and appends to the parent
transcript:

- happy path (client is serialized by acks): parent `lastChunkIndex + 1 ===
  chunkIndex` → O(1) append;
- otherwise → full re-stitch from the segment docs (idempotent fallback).

The parent's `transcript` lines use the existing `[time: m:ss.s-m:ss.s] text`
contract, formatted in the API (`lib/transcript.ts`) from segment ms values.
`receivedChunks` counts stored segments.

### 5.3 Pipeline

`advanceRecording` is unchanged for the live path except: the transcription
lease is acquired **only** when actually transcribing (file path), so a live
session no longer takes a 12-minute lease for a no-op.

### 5.4 Deletions

- `app/api/recordings/[id]/chunks/route.ts` (per-chunk ASR + music buffer)
- `recordChunkTranscript` (replaced by `recordSegmentTranscript`)
- unreachable branch + helpers in `useRecordingUpload.ts`, `chunkQueue.ts`,
  `webRecorder.ts`, `audio-wav.ts`, client VAD assets + dependency, orphaned
  chunk-file sweep, `releaseLease`/`storeDoclingTaskId` dead code.

## 6. Client integration

New `lib/micStream.ts` (platform-split like `ProgressIndicator`):

- `web`: AudioWorklet in `public/assets/audio/pcm-worklet.js`; prefer
  `AudioContext({ sampleRate: 16000 })`, verify actual rate and report it;
  Firefox fallback: default rate + biquad low-pass + decimation; batch to
  100 ms `Int16Array` frames.
- `native`: `expo-audio` `useAudioStream({ sampleRate: 16000, channels: 1,
  encoding: 'int16' })`, `onBuffer` → same batching; verify `stream.sampleRate`.
- Emits `onFrame(Int16Array, tMs)`; the WS client owns framing, sequencing,
  the ack-lag buffer (60 s PCM ring, trimmed on ack), reconnect with jittered
  backoff (0.5→8 s), `hello`/`resume`, ping/pong trust, and `bye`.

`useRecordingUpload` is rewritten around `micStream + streamClient`:

1. Request permissions; capture mic.
2. Create session + fetch ticket (`POST /session`, `POST /ws-ticket`).
3. Connect WS; on `segment` → POST `/segments` → `ack`; on `partial` → update
   UI captions; on `final` → drain posts → `POST /finalize` → drive `/process`
   ticks as today.
4. Crash recovery: the localStorage orphan key stays (finalize on next mount);
   locally persisted `chunkIndexBase`/`lastAckedSeq` let a resumed session
   continue numbering after a sidecar `reset`.

UI: the Record tab shows live captions from `partial`/`segment` events (the old
static "checkpoints" badge is replaced by real state).

## 7. Deployment

- `fly.toml`: `shared-cpu-4x` / 4 GB floor (8 GB for headroom),
  `min_machines_running = 1`, `auto_stop_machines = "stop"`,
  `[http_service.concurrency] type = "connections"`, `kill_timeout = 60`.
- `Dockerfile`: `python:3.12-slim` (fixes the 3.11/pyproject mismatch), model
  pre-downloaded into the image at build (`ARG ASR_MODEL=small.en`).
- Uvicorn entrypoint sets `ws_max_size=65536`, `ws_per_message_deflate=False`,
  `workers=1`, ping 20/20.
- Local dev: sidecar reads `.env` near the repo root / `packages/api/.env.local`
  for `WALFLY_WS_SECRET`; Next reads the same value (documented in SETUP.md and
  `.env.example`).

## 8. Testing

- Sidecar (pytest): VAD state machine vs scripted probability sequences; LA-2
  commit points vs scripted hypotheses; protocol/resume/ack/backpressure via
  `TestClient.websocket_connect` with a **fake Transcriber** (fast, deterministic);
  one slow integration test booting real uvicorn with a tiny model.
- API: `formatTimeRange` unit tests; segments route idempotency/ordering logic
  extracted into a pure helper where possible.
- Client: typecheck + a web smoke path (manual) — record in the browser,
  observe partials, stop, confirm transcript/enrichment in the app.
- Load: synthetic stream generator script (N sessions, paced 100 ms frames).

## 9. Phases

- **Phase 1 — this branch**: streaming ingest end-to-end (sidecar WS + web
  client + native via `useAudioStream`), segment checkpoints, deletions,
  testing, deploy config.
- **Phase 2 — live enrichment** (03): `POST /api/recordings/{id}/live`
  rolling ops-based updates (~every 2 min) + periodic rebuild + final pass;
  server-side quote grounding; insights taxonomy (decisions, open questions/
  risks, quotes, entities); raise/replace `MAX_ENRICH_CHARS = 48_000` (today
  the final pass silently truncates recordings longer than ~45 min); UI cards.
- **Phase 3 — optional**: Bee ADTS passthrough (`codec: "aac_adts"`, Python
  port of `AdtsFramer` + incremental PyAV decode; kept off this branch because
  the Bee work is independent), local-capture fallback when the sidecar is
  unreachable, Opus upgrade via WebCodecs, diarization post-pass, GPU/Groq
  escalation.

## 10. Open questions

1. Native capture needs on-device verification (interruptions, background FGS
   config, `AudioStream` behavior on iOS/Android).
2. Does the transcript contract stay line-per-segment, or move to JSON segments
   + renderer? (Phase 2 candidate; segments are already stored individually.)
3. Bandwidth on cellular for PCM (28.8 MB/15 min) — acceptable for v1, Opus is
   the protocol-ready upgrade.
4. Replay ring TTL / memory vs. long reconnects (5 min / 200 segments chosen).
5. Whether DELETE-cascade should also cover the legacy `recording_chunks_v2`
   docs written by the old pipeline (currently cascade uses the same collection,
   so yes for both).
