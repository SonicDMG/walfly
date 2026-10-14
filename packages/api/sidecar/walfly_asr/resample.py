"""Streaming PCM resampler built on PyAV (already a dependency of faster-whisper).

Clients are asked to send 16 kHz mono s16le, but not every browser can capture
at 16 kHz (see research note 01 §3). This is the server-side safety net: it
converts whatever integer PCM rate arrives into the 16 kHz float32 the pipeline
consumes, incrementally, with no decoding step.
"""

from __future__ import annotations

import logging

import numpy as np

log = logging.getLogger("walfly.resample")

_IN_FORMATS = {
    8: "u8",
    16: "s16",
    24: "s32",
    32: "s32",
}


class PcmResampler:
    def __init__(self, in_rate: int, out_rate: int = 16000, bits: int = 16) -> None:
        import av

        if bits not in _IN_FORMATS:
            raise ValueError(f"unsupported PCM bit depth: {bits}")
        self._in_rate = int(in_rate)
        self._out_rate = int(out_rate)
        self._bits = bits
        self._scale = {8: 128.0, 16: 32768.0, 24: 2147483648.0, 32: 2147483648.0}[bits]
        self._offset = 128.0 if bits == 8 else 0.0
        self._resampler = None
        if self._in_rate != self._out_rate:
            self._resampler = av.AudioResampler(
                format="s16", layout="mono", rate=self._out_rate
            )

    @property
    def passthrough(self) -> bool:
        return self._resampler is None

    def process(self, pcm_bytes: bytes) -> np.ndarray:
        """Convert one chunk of little-endian PCM into 16 kHz float32 samples."""
        bytes_per_sample = self._bits // 8
        usable = len(pcm_bytes) - (len(pcm_bytes) % bytes_per_sample)
        if usable <= 0:
            return np.empty(0, dtype=np.float32)

        if self.passthrough:
            return _bytes_to_float32(pcm_bytes[:usable], self._bits, self._scale, self._offset)

        import av

        frame = av.AudioFrame(format=_IN_FORMATS[self._bits], layout="mono", samples=usable // bytes_per_sample)
        frame.sample_rate = self._in_rate
        frame.planes[0].update(pcm_bytes[:usable])
        pieces: list[np.ndarray] = []
        for out_frame in self._resampler.resample(frame):  # type: ignore[union-attr]
            arr = out_frame.to_ndarray().astype(np.float32).reshape(-1)
            pieces.append(arr / 32768.0)
        return np.concatenate(pieces) if pieces else np.empty(0, dtype=np.float32)


def _bytes_to_float32(pcm_bytes: bytes, bits: int, scale: float, offset: float) -> np.ndarray:
    dtype = {8: np.uint8, 16: np.int16, 24: None, 32: np.int32}[bits]
    if bits == 24:
        # Unpack 3-byte little-endian samples the slow way; 24-bit capture is rare.
        raw = np.frombuffer(pcm_bytes, dtype=np.uint8).reshape(-1, 3)
        values = (
            raw[:, 0].astype(np.int32)
            | (raw[:, 1].astype(np.int32) << 8)
            | (raw[:, 2].astype(np.int32) << 16)
        )
        values = (values << 8) >> 8  # sign-extend
        return values.astype(np.float32) / scale
    values = np.frombuffer(pcm_bytes, dtype=dtype).astype(np.float32)
    if offset:
        values = values - offset
    return values / scale
