"""Walfly ASR sidecar — FastAPI application.

Endpoints:
  GET  /health              — liveness + model readiness
  POST /v1/transcribe       — whole-file transcription (non-live recordings)
  WS   /v1/stream           — live streaming transcription (the new path)
  GET  /metrics             — Prometheus text format, token-gated

Run locally (repo root):
  uv run --project packages/api/sidecar python packages/api/sidecar/transcribe_sidecar.py

The streaming design lives in `streaming-plan.md` (repo root); evidence in
`research_notes/Streaming audio sidecar/`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import struct
import time
import uuid
from contextlib import asynccontextmanager

import numpy as np
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse

from walfly_asr import protocol
from walfly_asr.asr import FILE, AsrPool, DecodeJob
from walfly_asr.auth import TicketValidator
from walfly_asr.config import load_settings
from walfly_asr.markdown import render_markdown
from walfly_asr.resample import PcmResampler
from walfly_asr.session import StreamSession

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("sidecar")

settings = load_settings()
validator = TicketValidator(settings.ws_secret)
pool = AsrPool(settings)

_sessions: dict[str, StreamSession] = {}
_sessions_lock = asyncio.Lock()
_counters = {"sessions_total": 0, "segments_total": 0, "gaps_total": 0, "rejects_total": 0}


# ── lifecycle ────────────────────────────────────────────────────────────────

async def _reaper_loop() -> None:
    while True:
        await asyncio.sleep(60)
        now = time.monotonic()
        async with _sessions_lock:
            for session_id, session in list(_sessions.items()):
                if session.attached:
                    continue
                idle_for = now - session.last_activity
                if idle_for > settings.session_ttl_s or idle_for > settings.max_session_s:
                    session.request_stop()
                    session.shutdown()
                    del _sessions[session_id]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pool.start()
    asyncio.get_running_loop().create_task(_reaper_loop())
    # Do not block startup on model load (Fly healthchecks); report readiness via /health.
    asyncio.get_running_loop().create_task(_log_model_readiness())
    yield
    async with _sessions_lock:
        for session in _sessions.values():
            session.request_stop()
            await asyncio.to_thread(session.wait_finished, 10)
            session.shutdown()
        _sessions.clear()
    pool.shutdown()


app = FastAPI(title="Walfly ASR Sidecar", version="0.2.0", lifespan=lifespan)


async def _log_model_readiness() -> None:
    ready = await asyncio.to_thread(pool.wait_until_ready, 600)
    log.info("ASR pool ready=%s (%s workers, model=%s)", ready, settings.workers, settings.model)


# ── HTTP ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({
        "status": "ok",
        "model": settings.model,
        "compute": f"{settings.device}/{settings.compute_type}",
        "workers": settings.workers,
        "modelReady": pool.wait_until_ready(0.01),
        "sessions": len(_sessions),
    })


@app.post("/v1/transcribe")
async def transcribe_file(files: UploadFile = File(...)) -> JSONResponse:
    """Whole-file transcription, contract-compatible with the old sidecar.

    Returns `{"markdown": "..."}` where each line is `[time: m:ss.s-m:ss.s] text`.
    An empty string means the file contained no speech.
    """
    audio_bytes = await files.read()
    log.info("transcribe request: name=%s size=%d", files.filename, len(audio_bytes))
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="empty upload")

    try:
        audio = await asyncio.to_thread(_decode_file_audio, audio_bytes)
    except Exception as exc:  # noqa: BLE001
        log.exception("file decode failed: %s", exc)
        raise HTTPException(status_code=415, detail=f"could not decode audio: {exc}") from exc

    result_q: "queue.Queue" = queue.Queue()
    job = DecodeJob(
        session_id=f"file-{uuid.uuid4()}",
        kind=FILE,
        audio=audio,
        result_q=result_q,
        language=settings.language,
    )
    pool.submit(job)
    try:
        result = await asyncio.to_thread(result_q.get, True, 600)
    except queue.Empty as exc:
        raise HTTPException(status_code=504, detail="transcription timed out") from exc

    markdown = render_markdown([s for s in result.segments if s.get("text")])
    log.info("transcribe done: %d chars, %d segments", len(markdown), len(result.segments))
    return JSONResponse({"markdown": markdown})


def _decode_file_audio(audio_bytes: bytes) -> np.ndarray:
    from faster_whisper.audio import decode_audio

    import io

    return decode_audio(io.BytesIO(audio_bytes), sampling_rate=settings.sample_rate)


# ── WebSocket streaming ──────────────────────────────────────────────────────

@app.websocket("/v1/stream")
async def stream(websocket: WebSocket) -> None:
    loop = asyncio.get_running_loop()
    subprotocols = list(websocket.scope.get("subprotocols") or [])
    await websocket.accept(subprotocol=protocol.PROTOCOL_NAME if protocol.PROTOCOL_NAME in subprotocols else None)

    # ── auth ────────────────────────────────────────────────────────────────
    origin = websocket.headers.get("origin")
    if origin and not _origin_allowed(origin):
        _counters["rejects_total"] += 1
        await _close_with_error(websocket, protocol.CLOSE_AUTH, "origin not allowed")
        return
    token = validator.ticket_from_subprotocols(subprotocols)
    ticket = validator.validate(token) if token else None
    if ticket is None:
        _counters["rejects_total"] += 1
        await _close_with_error(websocket, protocol.CLOSE_AUTH, "missing or invalid ticket")
        return

    # ── hello ───────────────────────────────────────────────────────────────
    try:
        hello = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except (asyncio.TimeoutError, ValueError):
        await _close_with_error(websocket, protocol.CLOSE_IDLE, "hello timeout")
        return
    if hello.get("t") != "hello" or hello.get("sessionId") != ticket.session_id:
        await _close_with_error(websocket, protocol.CLOSE_AUTH, "hello does not match ticket")
        return
    codec = hello.get("codec") or "pcm_s16le"
    if codec != "pcm_s16le":
        # `aac_adts` (Bee) is a planned extension; reject loudly rather than misparse.
        await _close_with_error(websocket, protocol.CLOSE_INTERNAL, f"unsupported codec {codec!r}")
        return
    sample_rate = int(hello.get("sampleRate") or settings.sample_rate)
    channels = int(hello.get("channels") or 1)
    if channels != 1:
        await _close_with_error(websocket, protocol.CLOSE_INTERNAL, "only mono is supported")
        return
    resume_from = -1
    resume = hello.get("resume") or {}
    try:
        if resume.get("fromSeq") is not None:
            resume_from = int(resume["fromSeq"])
    except (TypeError, ValueError):
        resume_from = -1

    # ── session ─────────────────────────────────────────────────────────────
    session_id = ticket.session_id
    reset = False
    async with _sessions_lock:
        existing = _sessions.get(session_id)
        if existing is not None and existing.attached:
            await _close_with_error(websocket, protocol.CLOSE_DUPLICATE, "session already streaming")
            return
        if existing is None:
            if len(_sessions) >= settings.max_sessions:
                await _close_with_error(websocket, protocol.CLOSE_OVERLOADED, "sidecar at capacity")
                return
            existing = StreamSession(
                session_id=session_id,
                settings=settings,
                pool=pool,
            )
            _sessions[session_id] = existing
            _counters["sessions_total"] += 1
            existing.start()
            reset = resume_from >= 0
    session = existing

    outbox: "asyncio.Queue[dict | None]" = asyncio.Queue()
    writer = loop.create_task(_writer_loop(websocket, outbox))

    def sink(message: dict) -> None:
        try:
            loop.call_soon_threadsafe(outbox.put_nowait, message)
        except RuntimeError:
            pass  # loop closed during teardown

    session.set_sink(sink)
    await websocket.send_text(protocol.dumps(protocol.ready(
        session_id, sample_rate=settings.sample_rate,
        resumed_from_seq=resume_from if resume_from >= 0 else None,
        reset=reset,
    )))
    if resume_from >= 0:
        session.replay(resume_from)

    resampler = None if sample_rate == settings.sample_rate else PcmResampler(sample_rate)
    expected_seq = resume_from if resume_from >= 0 else None
    last_ack_sent = -1
    close_code = protocol.CLOSE_CLEAN
    reader_error: str | None = None

    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive(), timeout=5)
            except asyncio.TimeoutError:
                if time.monotonic() - session.last_activity > settings.idle_timeout_s:
                    close_code = protocol.CLOSE_IDLE
                    session.request_stop()
                    break
                if session.queue_lag_ms() >= settings.queue_close_ms:
                    close_code = protocol.CLOSE_OVERLOADED
                    session.request_stop()
                    break
                if time.monotonic() - session.started_at > settings.max_session_s:
                    session.request_stop()
                    break
                continue

            kind = raw.get("type")
            if kind == "websocket.disconnect":
                break
            if raw.get("bytes") is not None:
                parsed = _parse_frame(raw["bytes"])
                if parsed is None:
                    reader_error = "bad frame"
                    break
                seq, _t_ms, payload = parsed
                if expected_seq is not None and seq < expected_seq:
                    continue  # duplicate after resume
                expected_seq = seq + 1
                samples = resampler.process(payload) if resampler else _pcm_to_float32(payload)
                session.feed_audio(seq, samples)
            elif raw.get("text") is not None:
                try:
                    message = json.loads(raw["text"])
                except ValueError:
                    continue
                session.handle_control(message)
                if message.get("t") == "bye":
                    session.request_stop()
                    break

            # Ack what the processor has consumed (replay-safe boundary).
            consumed = session.consumed_seq()
            if consumed > last_ack_sent:
                last_ack_sent = consumed
                outbox.put_nowait(protocol.ack(consumed))
    except Exception as exc:  # noqa: BLE001
        log.exception("stream error for session %s: %s", session_id, exc)
        close_code = protocol.CLOSE_INTERNAL
    finally:
        # On a stop, keep the sink attached until the processor has flushed the
        # in-flight segment and sent `final`; only then detach and close.
        if session.stop_requested or close_code != protocol.CLOSE_CLEAN:
            await asyncio.to_thread(session.wait_finished, 30)
        session.set_sink(None)
        outbox.put_nowait(None)
        try:
            await asyncio.wait_for(writer, timeout=10)
        except Exception:  # noqa: BLE001
            writer.cancel()
        if reader_error is not None:
            close_code = protocol.CLOSE_INTERNAL
        try:
            await websocket.close(code=close_code)
        except Exception:  # noqa: BLE001
            pass
        log.info("session %s closed (%d): %s", session_id, close_code, "consumer_done" if session.finished else "detached")


async def _writer_loop(websocket: WebSocket, outbox: "asyncio.Queue[dict | None]") -> None:
    while True:
        message = await outbox.get()
        if message is None:
            return
        kind = message.get("t")
        if kind == "segment":
            _counters["segments_total"] += 1
        elif kind == "gap":
            _counters["gaps_total"] += 1
        await websocket.send_text(protocol.dumps(message))


async def _close_with_error(websocket: WebSocket, code: int, message: str) -> None:
    try:
        await websocket.send_text(protocol.dumps(protocol.error("auth" if code == protocol.CLOSE_AUTH else "protocol", message)))
        await websocket.close(code=code)
    except Exception:  # noqa: BLE001
        pass


def _origin_allowed(origin: str) -> bool:
    if "*" in settings.allowed_origins:
        return True
    normalized = origin.lower().split("://")[-1].rstrip("/")
    return any(normalized == allowed.lower().split("://")[-1].rstrip("/") for allowed in settings.allowed_origins)


def _parse_frame(raw: bytes) -> tuple[int, int, bytes] | None:
    if len(raw) < protocol.HEADER_SIZE or len(raw) > protocol.MAX_FRAME_BYTES:
        return None
    seq, t_ms = struct.unpack_from("<II", raw, 0)
    payload = raw[protocol.HEADER_SIZE:]
    if len(payload) > protocol.MAX_PAYLOAD_BYTES or len(payload) == 0:
        return None
    return seq, t_ms, payload


def _pcm_to_float32(payload: bytes) -> np.ndarray:
    usable = len(payload) - (len(payload) % 2)
    return np.frombuffer(payload[:usable], dtype="<i2").astype(np.float32) / 32768.0


# ── metrics ──────────────────────────────────────────────────────────────────

@app.get("/metrics")
async def metrics(token: str | None = None) -> PlainTextResponse:
    if not settings.metrics_token or token != settings.metrics_token:
        raise HTTPException(status_code=404, detail="not found")
    pool_metrics = pool.metrics()
    lines = [
        "# TYPE walfly_sessions_current gauge",
        f"walfly_sessions_current {len(_sessions)}",
        "# TYPE walfly_sessions_total gauge",
        f"walfly_sessions_total {_counters['sessions_total']}",
        "# TYPE walfly_segments_total gauge",
        f"walfly_segments_total {_counters['segments_total']}",
        "# TYPE walfly_gaps_total gauge",
        f"walfly_gaps_total {_counters['gaps_total']}",
        "# TYPE walfly_rejects_total gauge",
        f"walfly_rejects_total {_counters['rejects_total']}",
        "# TYPE walfly_model_ready gauge",
        f"walfly_model_ready {1 if pool.wait_until_ready(0.01) else 0}",
        "# TYPE walfly_decode_ms_total counter",
        f"walfly_decode_ms_total {pool_metrics['decode_ms_total']:.1f}",
        "# TYPE walfly_decode_audio_ms_total counter",
        f"walfly_decode_audio_ms_total {pool_metrics['audio_ms_total']:.1f}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n")


# ── entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # SIDECAR_PORT wins, then the platform-injected PORT, then the local default.
    port = int(os.environ.get("SIDECAR_PORT", os.environ.get("PORT", "8888")))
    log.info("Starting Walfly ASR sidecar on port %d (model=%s)", port, settings.model)
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=port,
        workers=1,  # in-memory sessions cannot span worker processes
        ws_max_size=protocol.MAX_FRAME_BYTES * 2,
        ws_per_message_deflate=False,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        log_level="info",
    )
