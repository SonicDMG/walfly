"""Silero VAD (streaming, stateful) + the segmentation state machine.

Two layers, deliberately separate:

- `SileroVadStream` wraps the ONNX model with per-session LSTM state. It is the
  only piece that touches onnxruntime; the model file is the one vendored by
  faster-whisper (`faster_whisper/assets/silero_vad_v6.onnx`), so the sidecar
  needs no extra VAD dependency and no torch.
- `VadSegmenter` is a pure state machine over `(probability, now_s)` inputs. It
  is unit-testable with synthetic probability sequences (see
  `tests/test_vad_segmenter.py`) and encodes the operating parameters from the
  research: hysteresis, speech confirmation, a minimum amount of speech before a
  segment opens, silence-based cuts, pre/post-roll, and a forced cut placed by
  the session at the quietest moment.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger("walfly.vad")

FRAME_SAMPLES = 512          # 32 ms @ 16 kHz — the model's native window
CONTEXT_SAMPLES = 64         # left context the v5/v6 ONNX models expect


def default_vad_model_path() -> Path:
    """The Silero v6 ONNX asset vendored inside faster-whisper."""
    from faster_whisper.vad import get_assets_path

    return Path(get_assets_path()) / "silero_vad_v6.onnx"


class SileroVadStream:
    """Stateful streaming wrapper around the Silero ONNX model.

    faster-whisper's own `SileroVADModel` is stateless (it zeroes h/c per call
    and batches whole files); streaming needs the LSTM state carried across
    512-sample frames, which is what this class does.
    """

    def __init__(self, model_path: str | Path | None = None) -> None:
        import onnxruntime as ort

        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        options.log_severity_level = 4
        path = str(model_path or default_vad_model_path())
        self._session = ort.InferenceSession(
            path, providers=["CPUExecutionProvider"], sess_options=options
        )
        self.reset()

    def reset(self) -> None:
        self._h = np.zeros((1, 1, 128), dtype=np.float32)
        self._c = np.zeros((1, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        """Return P(speech) for one 512-sample float32 frame."""
        frame = np.asarray(frame, dtype=np.float32).reshape(1, -1)
        if frame.shape[1] != FRAME_SAMPLES:
            raise ValueError(f"expected {FRAME_SAMPLES} samples, got {frame.shape[1]}")
        model_input = np.concatenate([self._context, frame], axis=1)
        prob, self._h, self._c = self._session.run(
            None, {"input": model_input, "h": self._h, "c": self._c}
        )
        self._context = frame[..., -CONTEXT_SAMPLES:]
        return float(np.asarray(prob, dtype=np.float32).reshape(-1)[0])


@dataclass(frozen=True)
class VadConfig:
    start_threshold: float = 0.5
    end_threshold: float = 0.35
    start_confirm_frames: int = 2
    min_speech_ms: float = 250.0
    open_speech_ms: float = 1000.0   # a segment only opens at >= 1 s of speech
    silence_cut_ms: float = 800.0
    pre_roll_s: float = 0.3
    post_roll_s: float = 0.4
    force_cut_s: float = 25.0
    overlap_s: float = 0.5           # only the segment after a forced cut overlaps
    frame_ms: float = 1000.0 * FRAME_SAMPLES / 16000.0


@dataclass(frozen=True)
class SegmentClosed:
    start_s: float
    end_s: float
    overlap: bool  # True when this segment's audio overlaps the previous final


@dataclass(frozen=True)
class Open:
    """Emitted when a segment opens (informational — the session needs nothing)."""


@dataclass(frozen=True)
class ForceCut:
    """The segment reached the forced-cut length; the session picks the cut point."""


Event = SegmentClosed | Open | ForceCut


class VadSegmenter:
    _SILENCE = 0
    _SPEECH = 1

    def __init__(self, config: VadConfig | None = None) -> None:
        self.config = config or VadConfig()
        self._state = self._SILENCE
        self._hit = 0
        self._seg_start_s = 0.0
        self._last_speech_s = 0.0
        self._silence_ms = 0.0
        self._speech_ms = 0.0
        self._overlap_next = False
        self._force_pending = False

    # ── introspection (tests + session scheduling) ──────────────────────────
    @property
    def is_open(self) -> bool:
        return self._state == self._SPEECH

    @property
    def seg_start_s(self) -> float:
        return self._seg_start_s

    @property
    def last_speech_s(self) -> float:
        return self._last_speech_s

    @property
    def speech_ms(self) -> float:
        return self._speech_ms

    def process(self, prob: float, now_s: float) -> Event | None:
        cfg = self.config
        if self._state == self._SILENCE:
            if prob >= cfg.start_threshold:
                self._hit += 1
                if self._hit >= cfg.start_confirm_frames:
                    self._state = self._SPEECH
                    self._seg_start_s = now_s - cfg.pre_roll_s
                    self._last_speech_s = now_s
                    self._silence_ms = 0.0
                    self._speech_ms = cfg.start_confirm_frames * cfg.frame_ms
                    return Open()
            else:
                self._hit = 0
            return None

        # SPEECH
        if prob >= cfg.end_threshold:
            self._last_speech_s = now_s
            self._silence_ms = 0.0
            self._speech_ms += cfg.frame_ms
        else:
            self._silence_ms += cfg.frame_ms

        if self._silence_ms >= cfg.silence_cut_ms:
            return self._close(self._last_speech_s + cfg.post_roll_s)

        if not self._force_pending and (self._last_speech_s - self._seg_start_s) >= cfg.force_cut_s:
            # The session computes the quietest cut point and calls force_cut();
            # until it does, do not re-raise the event every frame.
            self._force_pending = True
            return ForceCut()
        return None

    def force_cut(self, cut_s: float) -> SegmentClosed:
        """Close at `cut_s` and immediately reopen with overlap."""
        self._force_pending = False
        closed = SegmentClosed(
            start_s=self._seg_start_s, end_s=cut_s, overlap=self._overlap_next
        )
        # Reopen: the next segment starts `overlap_s` before the cut so ASR can
        # re-anchor the boundary word; `_overlap_next` flags it for dedupe.
        self._seg_start_s = max(0.0, cut_s - self.config.overlap_s)
        self._last_speech_s = cut_s
        self._silence_ms = 0.0
        self._speech_ms = 0.0
        self._overlap_next = True
        return closed

    def flush(self, now_s: float | None = None) -> SegmentClosed | None:
        """Close an open segment at stop time. Returns None when nothing opened.

        The end extends to `last_speech + post_roll`; the ring clips to whatever
        audio actually arrived. `now_s` is accepted for call-site symmetry and
        used only to avoid extending past the real stream end.
        """
        if self._state != self._SPEECH:
            return None
        end_s = self._last_speech_s + self.config.post_roll_s
        if now_s is not None:
            end_s = min(end_s, max(now_s, self._last_speech_s))
        return self._close(end_s)

    def _close(self, end_s: float) -> SegmentClosed | None:
        cfg = self.config
        opened = self._speech_ms >= cfg.open_speech_ms
        closed = SegmentClosed(
            start_s=self._seg_start_s,
            end_s=end_s,
            overlap=self._overlap_next,
        )
        self._state = self._SILENCE
        self._hit = 0
        self._silence_ms = 0.0
        self._speech_ms = 0.0
        self._overlap_next = False
        self._force_pending = False
        return closed if opened else None
