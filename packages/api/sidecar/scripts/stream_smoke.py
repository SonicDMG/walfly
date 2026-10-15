#!/usr/bin/env python
"""Stream a local audio file through the sidecar's /v1/stream WebSocket.

Usage (sidecar running on :8888 with WALFLY_WS_SECRET=devsecret):

  uv run --project packages/api/sidecar python packages/api/sidecar/scripts/stream_smoke.py \
      /path/to/speech.wav --secret devsecret

Decodes any PyAV-readable file to 16 kHz mono s16le, mints a ticket the same
way the Next.js API does, sends `hello`, streams 100 ms binary frames, sends
`bye`, and prints every server event. Exit code 0 when a `final` arrived and at
least one `segment` was produced.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import uuid

import numpy as np

try:  # websockets >= 14
    from websockets.asyncio.client import connect
except ImportError:  # pragma: no cover - older websockets
    from websockets import connect


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def mint_ticket(secret: str, session_id: str, ttl_s: int = 300) -> str:
    expires_at = int(time.time()) + ttl_s
    nonce = b64url(os.urandom(9))
    signature = hmac.new(
        secret.encode(), f"v1|{session_id}|{expires_at}|{nonce}".encode(), hashlib.sha256
    ).digest()
    return f"v1.{b64url(session_id.encode())}.{expires_at}.{nonce}.{b64url(signature)}"


def decode_to_pcm16(path: str) -> np.ndarray:
    import av

    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    pieces: list[np.ndarray] = []
    with av.open(path) as container:
        stream = next(s for s in container.streams if s.type == "audio")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                pieces.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            pieces.append(out.to_ndarray().reshape(-1))
    if not pieces:
        raise SystemExit("no audio decoded")
    return np.concatenate(pieces).astype(np.int16)


async def run(args: argparse.Namespace) -> int:
    session_id = f"smoke-{uuid.uuid4()}"
    pcm = decode_to_pcm16(args.file)
    duration_s = len(pcm) / 16000
    frames = [pcm[index:index + 1600] for index in range(0, len(pcm), 1600)]
    print(f"streaming {duration_s:.1f}s in {len(frames)} frames → {args.url}")

    ticket = mint_ticket(args.secret, session_id)
    received: list[dict] = []
    final_seen = asyncio.Event()

    async with connect(
        args.url,
        subprotocols=["walfly.v1", f"ticket.{ticket}"],
        max_size=1 << 20,
        open_timeout=15,
    ) as websocket:
        await websocket.send(json.dumps({
            "t": "hello",
            "sessionId": session_id,
            "codec": "pcm_s16le",
            "sampleRate": 16000,
            "channels": 1,
        }))

        async def reader() -> None:
            async for raw in websocket:
                try:
                    message = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                received.append(message)
                kind = message.get("t")
                if kind in ("partial", "segment", "gap", "error", "final"):
                    text = message.get("text", "")
                    detail = f" {text[:80]!r}" if text else ""
                    print(f"  ← {kind} {message.get('seq', message.get('lastSeq', ''))}{detail}")
                if kind in ("error", "final"):
                    final_seen.set()
                    return

        reader_task = asyncio.create_task(reader())
        started = time.monotonic()
        for seq, frame in enumerate(frames):
            await websocket.send(struct.pack("<II", seq, seq * 100) + frame.tobytes())
            if args.pace:
                await asyncio.sleep(args.pace)
        await websocket.send(json.dumps({"t": "bye", "lastSeq": len(frames) - 1}))
        try:
            await asyncio.wait_for(reader_task, timeout=args.final_timeout)
        except asyncio.TimeoutError:
            print("timed out waiting for `final`")
            reader_task.cancel()

    wall = time.monotonic() - started
    segments = [m for m in received if m.get("t") == "segment"]
    partials = [m for m in received if m.get("t") == "partial"]
    print(
        f"\ndone in {wall:.1f}s (audio {duration_s:.1f}s, wall/audio {wall / max(duration_s, 0.1):.2f}) — "
        f"{len(partials)} partials, {len(segments)} segments, "
        f"{len([m for m in received if m.get('t') == 'gap'])} gaps"
    )
    for segment in segments:
        print(f"  [{segment['start']:6.2f}–{segment['end']:6.2f}s] {segment['text']}")
    ok = final_seen.is_set() and bool(segments)
    print("PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="audio file readable by PyAV")
    parser.add_argument("--url", default="ws://127.0.0.1:8888/v1/stream")
    parser.add_argument("--secret", default=os.environ.get("WALFLY_WS_SECRET", "devsecret"))
    parser.add_argument("--pace", type=float, default=0.0, help="seconds between frames (0 = fastest)")
    parser.add_argument("--final-timeout", type=float, default=60.0)
    args = parser.parse_args()
    sys.exit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()
