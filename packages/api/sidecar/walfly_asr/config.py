"""Runtime configuration for the Walfly ASR sidecar.

Everything is environment-driven so the same image runs locally (Apple
Silicon, tiny model) and on Fly (x86, small.en int8). Values are read once at
startup; nothing here touches the network.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger("walfly.config")

# The sidecar lives at packages/api/sidecar/walfly_asr/config.py — search these
# directories (most specific first) for a .env.local / .env on local dev.
_DOTENV_DIRS = [
    Path(__file__).resolve().parent.parent,        # packages/api/sidecar
    Path(__file__).resolve().parent.parent.parent,  # packages/api
    Path(__file__).resolve().parent.parent.parent.parent.parent,  # repo root
]


def load_dotenv_files() -> None:
    """Best-effort .env loading; silent no-op when python-dotenv is absent."""
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - dependency is declared
        return
    for directory in _DOTENV_DIRS:
        for name in (".env.local", ".env"):
            path = directory / name
            if path.is_file():
                load_dotenv(path, override=False)


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        log.warning("Ignoring non-integer %s=%r, using %d", name, raw, default)
        return default


@dataclass(frozen=True)
class Settings:
    # ── ASR ────────────────────────────────────────────────────────────────
    model: str = "small.en"
    device: str = "cpu"
    compute_type: str = "int8"
    language: str = "en"
    workers: int = 2
    cpu_threads: int = 2

    # ── Streaming protocol ────────────────────────────────────────────────
    sample_rate: int = 16000
    ws_secret: str | None = None
    allowed_origins: tuple[str, ...] = ("*",)
    metrics_token: str | None = None

    max_sessions: int = 4
    session_ttl_s: int = 300          # keep a detached session resumable this long
    idle_timeout_s: int = 45          # no audio and no ping → close
    max_session_s: int = 4 * 3600     # hard ceiling per session

    # Queue/backpressure (milliseconds of 16 kHz audio)
    queue_high_ms: int = 15_000
    queue_limit_ms: int = 30_000
    queue_close_ms: int = 60_000

    # Replay ring for un-acked segments
    replay_ring_segments: int = 200
    replay_ring_ms: int = 5 * 60 * 1000

    @classmethod
    def from_env(cls) -> "Settings":
        origins = _env("ALLOWED_ORIGINS", "*").strip()
        return cls(
            model=_env("ASR_MODEL", "small.en"),
            device=_env("ASR_DEVICE", "cpu"),
            compute_type=_env("ASR_COMPUTE_TYPE", "int8"),
            language=_env("ASR_LANGUAGE", "en"),
            workers=_env_int("ASR_WORKERS", 2),
            cpu_threads=_env_int("ASR_CPU_THREADS", 2),
            ws_secret=os.environ.get("WALFLY_WS_SECRET") or None,
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
            metrics_token=os.environ.get("METRICS_TOKEN") or None,
            max_sessions=_env_int("ASR_MAX_SESSIONS", 4),
        )


def load_settings() -> Settings:
    load_dotenv_files()
    settings = Settings.from_env()
    if not settings.ws_secret:
        log.warning(
            "WALFLY_WS_SECRET is not set — WebSocket upgrades will be rejected. "
            "Set it in packages/api/.env.local (shared with the Next.js app)."
        )
    if settings.allowed_origins == ("*",):
        log.warning("ALLOWED_ORIGINS=* — only safe for local development")
    return settings
