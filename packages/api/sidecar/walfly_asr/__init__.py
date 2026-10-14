"""Walfly ASR sidecar internals.

See `streaming-plan.md` at the repo root for the design, and
`research_notes/Streaming audio sidecar/` for the evidence behind it.
"""

from .config import Settings, load_settings

__all__ = ["Settings", "load_settings"]
