"""Wire protocol constants and message constructors.

Text frames are JSON control messages; binary frames are `[seq u32][t_ms u32]`
little-endian headers followed by PCM payload. Times in `partial`/`segment`
events are float seconds on the session clock (cumulative samples / 16000).
"""

from __future__ import annotations

import json

PROTOCOL_NAME = "walfly.v1"

# ── Close codes ─────────────────────────────────────────────────────────────
CLOSE_CLEAN = 1000
CLOSE_OVERLOADED = 1013
CLOSE_AUTH = 4401
CLOSE_IDLE = 4408
CLOSE_DUPLICATE = 4409
CLOSE_INTERNAL = 1011

# ── Limits ──────────────────────────────────────────────────────────────────
MAX_FRAME_BYTES = 32 * 1024        # whole binary frame, header included
MAX_PAYLOAD_BYTES = 16 * 1024
HEADER_SIZE = 8


def dumps(message: dict) -> str:
    return json.dumps(message, separators=(",", ":"))


def ready(session_id: str, *, sample_rate: int, resumed_from_seq: int | None = None,
          reset: bool = False) -> dict:
    message = {
        "t": "ready",
        "sessionId": session_id,
        "sampleRate": sample_rate,
        "codec": "pcm_s16le",
    }
    if resumed_from_seq is not None:
        message["resumedFromSeq"] = resumed_from_seq
    if reset:
        # The server has no memory of this session (restart / TTL expiry): the
        # client continues its own chunk numbering from where it left off.
        message["reset"] = True
    return message


def partial(revision: int, t_end: float, text: str) -> dict:
    return {"t": "partial", "revision": revision, "tEnd": round(t_end, 3), "text": text}


def segment(seq: int, start_s: float, end_s: float, text: str,
            avg_logprob: float | None = None) -> dict:
    """One finalized segment. `seq` is server-local; the client maps it onto the
    recording's global chunkIndex so reconnects to a fresh server never collide."""
    message = {
        "t": "segment",
        "seq": seq,
        "start": round(start_s, 3),
        "end": round(end_s, 3),
        "text": text,
    }
    if avg_logprob is not None:
        message["avgLogprob"] = round(avg_logprob, 3)
    return message


def ack(seq: int) -> dict:
    return {"t": "ack", "seq": seq}


def flow(lag_ms: int, limit_ms: int) -> dict:
    return {"t": "flow", "lagMs": lag_ms, "limitMs": limit_ms}


def gap(from_ms: int, to_ms: int) -> dict:
    return {"t": "gap", "fromMs": from_ms, "toMs": to_ms}


def final(last_seq: int) -> dict:
    return {"t": "final", "lastSeq": last_seq}


def pong(t0: float | None) -> dict:
    message: dict = {"t": "pong"}
    if t0 is not None:
        message["t0"] = t0
    return message


def error(code: str, message: str) -> dict:
    return {"t": "error", "code": code, "message": message}
