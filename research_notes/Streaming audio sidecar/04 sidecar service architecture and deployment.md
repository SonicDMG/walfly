# 04 — Streaming audio sidecar: service architecture and deployment

*Scope: redesign the existing HTTP/multipart ASR sidecar (`packages/api/sidecar/transcribe_sidecar.py`) into a WebSocket streaming service that runs server-side VAD + streaming Whisper per session, emits partials, and hands finalized segments to the existing client-driven pipeline.*

---

## TL;DR

- **Keep the sidecar as a separate, ASR-only service** (one Fly.io app, single region, one always-on machine). Vercel's WebSocket beta caps connections at 30 minutes (5 min default) on Pro/Enterprise — not a fit for hour-long capture ([Vercel duration limits](https://vercel.com/docs/functions/configuring-functions/duration), [Ably summary](https://ably.com/vercel/websockets-on-vercel)).
- **One uvicorn process**, asyncio for sockets, a bounded queue per session, and a fixed pool of **thread workers each owning its own `faster-whisper` model instance** (CTranslate2 releases the GIL; a single ct2 model serializes calls). VAD is Silero, <1 ms per 30 ms frame ([silero-vad](https://github.com/snakers4/silero-vad)).
- **CPU-only is enough**: int8 `small`/`turbo` on 4–8 vCPUs handles 2–6 concurrent sessions at RTF < 0.7. **Do not plan on Fly GPUs — deprecated as of 2026-07-31** ([Fly forum](https://community.fly.io/t/gpu-migration-fly-io-gpus-will-be-deprecated-as-of-july-31-2026/27110)). If quality demands escalate, the saner step is Groq `whisper-large-v3-turbo` at **$0.04/audio-hour** ([Groq docs](https://console.groq.com/docs/speech-to-text)) before any GPU VM.
- **Durability = client-driven checkpoints into the existing pipeline**: the sidecar emits monotonic `segment.seq`; the client POSTs each segment to `POST /api/recordings/{id}/chunks` (already idempotent via `_id = recordingId_chunk_NNNNNN`) and only then ACKs. The sidecar keeps an unacked replay ring (~5 min). A crash loses at most the in-flight segment. This preserves the "no background jobs, no detached promises" philosophy of `pipeline.ts`.
- **Auth: HMAC ticket minted by Next.js, carried in `Sec-WebSocket-Protocol`**, with an origin allowlist and single-use nonces. The sidecar holds exactly one secret — no Astra, LLM, or storage credentials ever reach it (the property `DEPLOY.md` advertises).
- Recommended box: **Fly `shared-cpu-8x` + 8 GB ≈ $46/mo** always-on, `kill_timeout = 60`, connection-based concurrency limits. When the sidecar is down, the client falls back to the existing local-capture + chunk-upload path, which stays untouched.

---

## Target architecture

```
 Expo client (mic → 16 kHz mono PCM s16le frames, 20 ms)
   │  wss://walfly-asr.fly.dev/v1/stream
   │  subprotocol: walfly.v1, ticket.<hmac>
   │                                             ┌──────────── Vercel (unchanged) ───────────┐
   │                                             │  POST /api/recordings/session             │
   │                                             │  POST /api/recordings/{id}/ws-ticket   ───┼─→ mints HMAC ticket (secret shared w/ sidecar)
   ├────────────────────────────────────────────►│  POST /api/recordings/{id}/chunks      ←──┼── client posts each finalized segment (idempotent upsert)
   │   text JSON: hello/ack/stop                 │  POST /api/recordings/{id}/finalize    ←──┼── status recording → uploaded → pipeline advances
   │   binary: PCM frames                        │        │                                   │
   │◄── text JSON: ready/partial/segment/        │        ▼                                   │
   │      flow/gap/reset/draining/final          │   Astra DB (recordings_v2, recording_chunks_v2)
   │                                             └───────────────────────────────────────────┘
   ▼
 Fly machine (single uvicorn process)                     per session:
   socket reader ──► bounded byte queue (30 s cap) ──► VAD gate (Silero, stateful)
        ▲                                                │ speech spans
        │ flow-control (lagMs)                            ▼
   unacked segment ring (5 min) ◄── finalizer ◄── job queue ──► worker pool (N threads,
                                                               N model instances, int8)
```

No Redis, no sidecar database, no cross-machine state. Reconnect to a different machine is tolerated by design.

---

## Process model and queue design

Add `stream_sidecar.py` to the same FastAPI app; keep the existing batch endpoints for compatibility. uvicorn knobs:

| Knob | Value | Why |
|---|---|---|
| `workers` | **1** | In-memory sessions can't span worker processes; Fly autoscales machines, not workers. |
| `ws_max_size` | `65536` (default 16 MB — [uvicorn settings](https://uvicorn.dev/settings)) | Our largest frame is 32 KB; 16 MB is a DoS lever. |
| `ws_max_queue` | `64` (default 32, `websockets` impl only) | Overflow closes the socket, so keep headroom for bursts. |
| `ws_ping_interval` / `ws_ping_timeout` | 20 / 20 (defaults) | Protocol ping detects half-dead phones; browsers pong automatically. |
| `ws_per_message_deflate` | `False` | Compressing PCM/JSON per message wastes CPU. |
| App heartbeat | server `{"type":"ping"}` every 15 s; close 4408 after 45 s of silence | Mobile radios/NAT drop idle TCP after 30–120 s ([websockets keepalive](https://websockets.readthedocs.io/en/13.1/topics/keepalive.html)); Fly proxy maintenance drops sockets without notice. |
| `kill_signal` / `kill_timeout` | `SIGTERM` / `60` (Fly default is 5 s, max 300 s — [Fly config](https://docs.fly.io/reference/configuration)) | Drain window for in-flight segments. |

**Session task graph.** On upgrade: `StreamSession(reader_task, vad_task, worker_jobs, writer)`. The rule: *nothing CPU-bound runs on the event loop*. Sockets and JSON stay async; VAD + ASR go to threads via a shared job queue.

- **Reader**: `receive_bytes()` loop; validate frame ≤ 32 KB; push into the session's bounded deque + `asyncio.Condition`. Text frames parse as control JSON (`hello`, `ack`, `stop`).
- **Bounded queue**: cap **30 s of audio** (16 kHz mono s16le = 32 KB/s → 960 KB/session). High-water at **15 s** → send `flow {lagMs, bufferLimitMs}`; the client buffers locally (it already records locally for the fallback path). At **30 s** → drop oldest 5 s, emit `gap {fromMs, toMs}` so the transcript renders the hole. At **60 s** → close 1013, client falls back to upload. Gaps are explicit events; workers never silently drop.
- **VAD**: Silero on 512-sample (32 ms) windows, stateful across frames, run inside the worker thread owning the session's decode state. Speech starts after ~250 ms, ends after ~600 ms of silence. Spans ≥ 1 s are queued as jobs.
- **Workers**: N threads, N `WhisperModel` instances, int8, `condition_on_previous_text=False`, `beam_size=1`, `cpu_threads=2`. Set `OMP_NUM_THREADS=1` and `torch.set_num_threads(1)` for VAD to avoid oversubscription. Partials use a LocalAgreement policy (transcribe the trailing ~6–10 s window every 800–1500 ms; commit tokens confirmed by two consecutive passes) — reference implementation [ufal/whisper_streaming](https://github.com/ufal/whisper_streaming); implement the policy directly, don't add the dependency.
- **Finalization**: silence boundary (or `stop`) → one authoritative pass over the span → `segment {seq, chunkIndex, startMs, endMs, text, final:true}` → client → chunks route → `ack`. Partials never reach the database.

**Backpressure policy in one line: short lags are signalled, long lags are the client's problem, and every drop is an explicit `gap` frame.**

---

## Session state machine

```
CONNECTING ──auth ok──► AUTHED ──hello──► ACTIVE ──lag≥15s──► BACKPRESSURED
     │                     │                 │  ◄──lag<8s──────────┘
     │ auth fail           │ no hello 10s    │ stop / idle 120s
     ▼                     ▼                 ▼
  CLOSED(4401)          CLOSED(4408)      FLUSHING ──final sent──► CLOSED(1000)
                                             ▲
             SIGTERM ──► DRAINING ──────────┘        worker/auth error ──► CLOSED(1011)
```

Rules: one writer per session (all sends queued through an `asyncio.Queue`), `seq` monotone per session epoch, session struct TTL 5 min after disconnect for resume, then freed. Idle timeout 120 s of no audio → close 1001; the client finalizes.

---

## Checkpoint / resume design (client-driven, matching the existing pipeline)

Rejected: **sidecar → Astra direct** (spreads Astra creds to the ASR box, forks schema ownership, breaks the "no credentials in the sidecar" property in `DEPLOY.md`) and **API polling pull** (adds a polling loop to a codebase that deliberately has none, and partials would arrive one poll late).

Handshake:

1. `POST /api/recordings/session` (exists) → `recordingId`.
2. `POST /api/recordings/{id}/ws-ticket` (new) → `HMAC(secret, sid|recordingId|userId|exp|nonce)`, TTL 120 s.
3. Connect with subprotocols `["walfly.v1","ticket.<base64url>"]`; server echoes `walfly.v1` and sends `ready {sessionEpoch, resumeSupported:true, formats:{rate:16000,channels:1,codec:pcm_s16le}}`.
4. Client `hello {recordingId, lastAckedSeq, chunkIndexBase}`. Same process still has the ring → replay `segment`s with `seq > lastAckedSeq`, then live resumes. Otherwise `reset {ack:[]}` → client derives the next `chunkIndex` from its locally persisted counter (AsyncStorage).
5. Per segment: client POSTs `/api/recordings/{id}/chunks` with `chunkIndex, offsetMs, duration, transcript`; on 200 sends `{"type":"ack","seq":N}`. **Acked ⟺ durable in Astra.** The sidecar ring holds unacked segments (200 segments / 5 min / 2 MB, whichever first).
6. `stop` (or idle finalize): last `segment(final)`, server sends `final {lastSeq}`, closes 1000; client then `POST /api/recordings/{id}/finalize` with `totalExpectedChunks` + `duration`. `finalizeLiveSession()` flips `recording → uploaded`; the existing pipeline's `isLiveSession` branch skips re-transcription. Finalize is idempotent (monotone `updateOne` on `_id`), so retries no-op.
7. Client-side durable state = `chunkIndexBase` + `lastAckedSeq`, rewritten after every ack.

### Failure-mode table

| Scenario | Data loss | System state | Recovery |
|---|---|---|---|
| **Client dies mid-session** | ≤ 1 segment sent but un-POSTed; later audio in the ring is replayable if the client returns within TTL | Sidecar idles 120 s → FLUSHING → free; recording stays `recording` | App restart → resume → replay → ack; else manual finalize; upload fallback still possible |
| **Sidecar dies** (crash, OOM, host migration) | In-flight unfinished span + ring; nothing acked is lost | Client sees 1006 → reconnect with backoff; new machine likely `reset` | Continue from local `chunkIndexBase`; `gap` for the hole; optionally fall back to upload |
| **API dies (Vercel)** | None while the ring holds: acks stall, client buffers, streaming continues | Sidecar unaffected; recording stuck `recording` | Retries are idempotent upserts; on API return, client drains backlog then acks; `MAX_TRANSIENT_ATTEMPTS` bounds the rest |
| **Client + sidecar die together** | Anything since the last successful POST (≤ client local buffer) | Recording stuck | Manual finalize; record-and-upload path is the escape hatch |
| **Astra down** | Same as API down: chunks route 5xx → no ack → client retries | Both services healthy | Existing pipeline retry/lease logic; no new machinery |
| **Deploy / SIGTERM** | In-flight span only, if the drain deadline is missed | DRAINING for `kill_timeout` (60 s) | Client reconnects to the new machine, resumes or resets |

---

## Auth / security

- **Transport**: Fly terminates TLS; `force_https = true` gives `wss://`. CORS does not apply to WebSocket handshakes (no preflight), so the token and origin check *are* the gates; keep CORS locked on remaining HTTP endpoints.
- **Token carriage — subprotocol wins.** Query-string tokens leak into proxy/access logs; cookies need `SameSite=None` third-party cookies to `walfly-asr.fly.dev`, which iOS Safari and Expo native make unreliable. `new WebSocket(url, ["walfly.v1", "ticket.<token>"])` is supported by browsers and React Native and is read from `websocket.scope["subprotocols"]` (remember `accept(subprotocol="walfly.v1")`). Keep a first-message `{"type":"auth"}` fallback for CLI tools (`wscat`); close 4401 after 5 s without valid auth either way.
- **Ticket validation**: HMAC-SHA256, `exp` ≤ 120 s, single-use nonce (LRU sized to the TTL window), bound to `recordingId` + `userId`; accept current + previous secret for rotation. This secret is the *only* credential on the sidecar.
- **Origin allowlist**: app web origin(s) + Expo scheme; allow missing `Origin` only when the ticket is valid (native clients may omit it).
- **Rate limiting** (in-process, no extra infra): max 2 concurrent sessions per `userId`; token bucket on new connections per IP (~10/min); one upgrade per ticket; 32 KB max frame; 4 h max session then forced finalize.
- **Locking it down**: private networking to Fly's 6PN isn't reachable from Vercel, so the sidecar stays public-but-gated — ticket-only WebSockets, `/health` public, `/metrics` bearer-gated, OpenAPI/docs disabled, batch `/v1/*` behind a shared header secret or decommissioned later. No Astra/LLM/storage keys on the box; enrichment stays in Next.js.

---

## Observability and operations

**Logs**: one JSON line per event (`session_start`, `vad_speech`, `segment_final`, `flow`, `gap`, `ack`, `session_end`) with `sessionId`, `recordingId`, `seq`, `rtfMs`, `queueMs`, `closeCode`. Never log transcript text or audio; lengths only.

**Metrics** (prometheus-client on a token-gated `/metrics`, scraped by Grafana Cloud free tier): `active_sessions`, `queue_lag_seconds` (histogram), `rtf` per finalized span, `partial_latency_ms` (job done → socket send), `segment_finalize_latency_ms`, `vad_speech_ratio`, `backpressure_events`, `gap_ms_total`, `reconnects`, `model_load_seconds`, `worker_busy`.

**Tracing**: a browser WebSocket can't carry custom headers, so pass W3C `traceparent` as a **query parameter** on the WS URL and echo it into every sidecar log line. Client → Vercel chunk/finalize POSTs carry `traceparent` normally, so one session stitches end-to-end in a single tracing backend. Skip OTel auto-instrumentation for WS in v1.

**Alerts**: p95 RTF > 0.8 for 10 min (capacity cliff); p95 queue lag > 15 s; active sessions ≥ 80% of tested capacity; reconnect rate > 5%/10 min; sustained `gap_ms_total`; process restarts > 1/h; model load > 60 s.

**Load testing**: `tools/wsload`, an async Python generator that opens N sockets streaming a real 16 kHz PCM corpus (recorded Walfly sessions + LibriSpeech) paced at 20 ms frames with jitter, using valid tickets; reports per-session partial latency, RTF, queue lag, drops, RSS. Run N = 1, 2, 4, 8, 16 and find the knee where p95 RTF crosses 0.7. Also soak one 2 h session (ring/VAD-state leaks) and `fly machine stop` mid-session to prove DRAINING.

**pytest**: unit-test the state machine, backpressure thresholds, ticket validation, and ack/replay with `TestClient.websocket_connect` (in-process, deterministic) against a **fake `Transcriber` injected via a protocol**. Then one real-socket integration test booting `uvicorn.Server` on an ephemeral port in a fixture, connecting with the `websockets` library, and asserting partial → segment → ack → resume → finalize against a tiny fixture model, marked `slow` and run nightly rather than per-push.

---

## Deployment recommendation and costs

**Stay two services.** The only sensible "merge" (running the API on Fly instead of Vercel) is out of scope; Vercel can't host the socket today.

- **Provider: Fly.io** — existing config, WS through the standard `[http_service]`, `[http_service.concurrency] type = "connections"` so the proxy load-balances and autostops on *open connections* ([Fly config ref](https://docs.fly.io/reference/configuration)). A live session keeps its machine running; when the last session closes, the machine stops after the idle window.
- **Machine**: `shared-cpu-8x`, 8 GB, primary region = where users are (existing `iad`; Fly also has `bom`, `lhr`, `fra`). `min_machines_running = 1`; `auto_stop_machines = "stop"` (**not** `"suspend"`: not recommended above 2 GB, and snapshots are disposable on deploy — [Fly suspend docs](https://docs.fly.io/reference/suspend-resume)); `max_machines` 2–3; soft limit ~6 connections/machine, hard limit 10. Cold-start model load is why the floor is 1.
- **Model**: bake the faster-whisper model into the image (int8 `small` v1; try `distil-large-v3`/`turbo` int8 if RTF allows). Don't route streaming through docling — import `faster_whisper` directly and keep docling imports lazy for the batch endpoints.
- **Session affinity**: unnecessary. Connections pin to one machine for their lifetime; cross-machine reconnect is handled by `reset` + client counters. Render explicitly warns its LB assigns reconnects at random ([Render WebSockets](https://render.com/docs/websocket)), so the design tolerates it anyway.
- **Breakage**: proxy maintenance and host migrations drop sockets; reconnect+resume is the mitigation, and Fly's drain sequence (`kill_signal` → wait `kill_timeout` → SIGTERM → SIGKILL, [long-running tasks](https://docs.fly.io/blueprints/long-running-tasks)) is why `kill_timeout = 60`.

| Option (always-on, monthly) | Cost | Verdict |
|---|---|---|
| Fly `shared-cpu-2x` + 2 GB (today) | ~$11 | Pilot only: 1 session, `small` int8 |
| **Fly `shared-cpu-8x` + 8 GB** | **~$46** | **Recommended**: 4–6 sessions with headroom |
| Fly `shared-cpu-4x` + 4 GB | ~$23 | Budget middle ground, ~2–3 sessions |
| Fly `performance-2x` + 4 GB (dedicated CPU) | $62 | Use if shared-CPU steal jitters RTF |
| Render Standard (1 CPU / 2 GB) | $25 | Simplest ops; no affinity; 30 s shutdown grace by default |
| Render Pro (2 CPU / 4 GB) | $85 | Worse $/vCPU than Fly |
| DO App Platform `basic-m` (2 / 4 GB) | $40 | Worst value; autoscaling needs dedicated `apps-d-*` ($78+) ([DO pricing](https://docs.digitalocean.com/products/app-platform/details/pricing)) |
| RunPod L4/A10-class GPU | ~$220–400 | Only if >20–30 sessions or large-v3 accuracy demanded; Fly GPUs are EOL |
| Groq `whisper-large-v3-turbo` API | $0.04/audio-hr (≈$8 for 200 h/mo) | Cheapest escalation for quality/latency; loses VAD control and data locality |

Prices from [fly.io/pricing](https://fly.io/pricing) + [Fly resource pricing](https://docs.fly.io/about/pricing) ($5/GB/mo above preset RAM) and [render.com/pricing](https://render.com/pricing).

**Sidecar down → fallback**: keep the existing capture-to-file + `POST /api/recordings/{id}/chunks` path as-is. Client policy: try WS connect with backoff (1 s → 30 s, jitter, ~5 tries); on upgrade/handshake failure or 1013, switch to local capture + chunk upload for the rest of the session and hide the live-transcript UI. Keep `/v1/transcribe` untouched during migration; retire it only after the streaming path replaces live sessions in production.

---

## Gotchas

1. **Never run Whisper on the event loop** — one blocking call stalls every session on the machine.
2. **`workers=1` is load-bearing**; multiple uvicorn workers silently fragment in-memory session state. Don't "fix" throughput with `--workers 4`.
3. **CTranslate2 model instances are single-flight**; concurrency comes from N instances in N threads. Budget ~0.5 GB RAM per int8 `small` instance.
4. **Thread oversubscription quietly halves throughput**: cap `cpu_threads/worker × workers × torch threads ≤ vCPUs`.
5. **uvicorn defaults are hostile here**: 16 MB `ws_max_size`, deflate on. Override both.
6. **Fly default `kill_timeout` is 5 s** — shorter than one ASR pass; without 60 s, every deploy loses the in-flight segment.
7. **Suspend ≠ durable state**: snapshots are discarded on deploy and >2 GB machines aren't recommended for suspend. Warm-keeping means keep it running.
8. **Render gives no connection affinity**; treat every reconnect as "possibly a different machine".
9. **Don't put tickets in query strings** (log leakage); don't log transcripts (privacy).
10. **The Dockerfile runs Python 3.11 while `pyproject.toml` requires ≥3.12** — pin one version before adding a second service entrypoint.
11. **Bake model files into the image**, or every cold start pays a multi-hundred-MB download before the first partial.

## Open questions

1. Can the Expo client hold a 3–4 h WebSocket over cellular, or does the OS suspend the app? Determines whether local buffering + gap events are the norm.
2. Codec: raw PCM (simple, 256 kbps) or Opus (bandwidth-friendly, server decode CPU)? Decide before building the frame path.
3. Real concurrency target for 6 months — 2, 6, or 30 sessions? The cost table collapses to one row if it's 2.
4. Speaker diarization later? It changes worker layout (pyannote + torch, GPU pressure) more than any other feature.
5. Multi-language expected? Turbo is multilingual; `small` is weaker outside English; distil models are English-only.
6. Offline/live-unavailable UX: is "live transcript unavailable, recording locally" acceptable when the sidecar is down?
7. Which Fly region? Pick by where the first 100 users are, not habit.
8. Does `recording_chunks_v2` need a `seq` field to audit duplicate/replayed POSTs, or is `chunkIndex` alone enough?
