"""The transcript markdown contract.

Both the streaming path (per finalized segment) and the file path (per
transcribed segment) render through here, so the `[time: m:ss.s-m:ss.s] text`
line format has exactly one implementation — the contract the Next.js pipeline,
search and chat all consume.
"""

from __future__ import annotations


def fmt_time(seconds: float) -> str:
    """Format seconds as M:SS.S, matching the historical docling-sidecar output."""
    if seconds < 0:
        seconds = 0.0
    minutes = int(seconds // 60)
    rest = seconds % 60
    return f"{minutes}:{rest:04.1f}"


def format_line(start_s: float, end_s: float, text: str) -> str:
    return f"[time: {fmt_time(start_s)}-{fmt_time(end_s)}] {text.strip()}"


def render_markdown(segments: list[dict]) -> str:
    """Render `[{start, end, text}]` dicts into timestamped markdown."""
    lines = []
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(format_line(float(seg.get("start", 0.0)), float(seg.get("end", 0.0)), text))
    return "\n\n".join(lines)
