"""Worker pool around faster-whisper.

CTranslate2 model instances are single-flight, so concurrency comes from N
threads each owning its own `WhisperModel`. Jobs are submitted to one shared
queue; results are posted back on a per-job queue (owned by the session), so no
callbacks ever cross into session state.

The `Transcriber` protocol keeps sessions testable: the protocol-level tests
inject a fake that returns scripted text instead of loading a model.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

import numpy as np

from .agreement import WordTok
from .config import Settings

log = logging.getLogger("walfly.asr")

PARTIAL = "partial"
FINAL = "final"
FILE = "file"


@dataclass
class DecodeJob:
    session_id: str
    kind: str                       # PARTIAL | FINAL
    audio: np.ndarray               # float32 mono @16 kHz
    result_q: "queue.Queue[DecodeResult]"
    window_start_s: float = 0.0     # session time of audio[0]
    seq: int = 0                    # finals only
    overlap: bool = False           # finals only — dedupe against previous final
    generation: int = 0             # partials only — reject results from closed segments
    initial_prompt: str | None = None
    language: str | None = None


@dataclass
class DecodeResult:
    job: DecodeJob
    text: str
    words: list[WordTok]            # session times (job.window_start_s + worker time)
    avg_logprob: float
    decode_ms: float
    segments: list[dict] = field(default_factory=list)  # file jobs: {start, end, text}


class Transcriber(Protocol):
    def submit(self, job: DecodeJob) -> None: ...
    def start(self) -> None: ...
    def shutdown(self) -> None: ...


class AsrPool:
    """N worker threads, N WhisperModel instances, one shared job queue."""

    def __init__(self, settings: Settings, *, model_factory: Callable[[], object] | None = None) -> None:
        self._settings = settings
        self._jobs: "queue.Queue[DecodeJob | None]" = queue.Queue()
        self._threads: list[threading.Thread] = []
        self._model_factory = model_factory
        self._models_ready = threading.Event()
        self._loaded = 0
        self._loaded_lock = threading.Lock()
        self._metrics = {"decode_ms_total": 0.0, "decode_count": 0, "audio_ms_total": 0.0}
        self._metrics_lock = threading.Lock()

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self) -> None:
        for index in range(max(1, self._settings.workers)):
            thread = threading.Thread(target=self._worker, args=(index,), name=f"asr-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def shutdown(self) -> None:
        for _ in self._threads:
            self._jobs.put(None)
        for thread in self._threads:
            thread.join(timeout=30)

    def wait_until_ready(self, timeout: float | None = None) -> bool:
        """Block until every worker has loaded its model (startup health gate)."""
        return self._models_ready.wait(timeout)

    def submit(self, job: DecodeJob) -> None:
        self._jobs.put(job)

    # ── metrics ─────────────────────────────────────────────────────────────
    def metrics(self) -> dict:
        with self._metrics_lock:
            return dict(self._metrics)

    # ── internals ───────────────────────────────────────────────────────────
    def _worker(self, index: int) -> None:
        """Own one model, execute jobs forever. Failures are contained here:
        a broken model load or decode must degrade to empty results, never
        wedge a session (its `final` has its own timeout on the session side)."""
        model: object | None = None
        next_load_attempt = 0.0

        while True:
            job = self._jobs.get()
            if job is None:
                return

            if model is None and time.monotonic() >= next_load_attempt:
                try:
                    model = self._load_model(index)
                    with self._loaded_lock:
                        self._loaded += 1
                        if self._loaded >= len(self._threads):
                            self._models_ready.set()
                except Exception as exc:  # noqa: BLE001
                    log.exception(
                        "worker %d could not load model %r (%s); answering jobs empty and retrying in 30s",
                        index, self._settings.model, exc,
                    )
                    next_load_attempt = time.monotonic() + 30.0

            if model is None:
                job.result_q.put(self._empty_result(job))
                continue

            try:
                result = self._decode(model, job)
            except Exception as exc:  # noqa: BLE001 — a bad decode must not kill the worker
                log.exception("decode failed for session %s (%s): %s", job.session_id, job.kind, exc)
                result = self._empty_result(job)
            job.result_q.put(result)

    def _load_model(self, index: int) -> object:
        settings = self._settings
        if self._model_factory is not None:
            return self._model_factory()
        from faster_whisper import WhisperModel

        started = time.monotonic()
        model = WhisperModel(
            settings.model,
            device=settings.device,
            compute_type=settings.compute_type,
            cpu_threads=settings.cpu_threads,
            num_workers=1,
        )
        log.info(
            "worker %d loaded model %s (%s/%s) in %.1fs",
            index, settings.model, settings.device, settings.compute_type,
            time.monotonic() - started,
        )
        return model

    @staticmethod
    def _empty_result(job: DecodeJob) -> DecodeResult:
        return DecodeResult(job=job, text="", words=[], avg_logprob=-1.0, decode_ms=0.0)

    def _decode(self, model: object, job: DecodeJob) -> DecodeResult:
        if job.kind == PARTIAL:
            segments, _info = model.transcribe(  # type: ignore[attr-defined]
                job.audio,
                beam_size=1,
                temperature=0.0,
                condition_on_previous_text=False,
                initial_prompt=job.initial_prompt,
                language=job.language or self._settings.language,
                without_timestamps=True,
                word_timestamps=False,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
            )
        else:
            segments, _info = model.transcribe(  # type: ignore[attr-defined]
                job.audio,
                beam_size=5,
                temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
                condition_on_previous_text=False,
                initial_prompt=job.initial_prompt,
                language=job.language or self._settings.language,
                word_timestamps=True,
                no_speech_threshold=0.6,
                log_prob_threshold=-1.0,
                compression_ratio_threshold=2.4,
            )

        started = time.monotonic()
        text_parts: list[str] = []
        words: list[WordTok] = []
        file_segments: list[dict] = []
        logprob_weighted = 0.0
        logprob_weight = 0.0
        for segment in segments:
            text_parts.append(segment.text.strip())
            weight = max(0.01, float(segment.end - segment.start))
            logprob_weighted += float(segment.avg_logprob) * weight
            logprob_weight += weight
            if job.kind == FILE:
                file_segments.append({
                    "start": job.window_start_s + float(segment.start),
                    "end": job.window_start_s + float(segment.end),
                    "text": segment.text.strip(),
                })
            segment_words = getattr(segment, "words", None)
            if segment_words:
                for word in segment_words:
                    words.append(
                        WordTok(
                            word=word.word,
                            start=job.window_start_s + float(word.start),
                            end=job.window_start_s + float(word.end),
                            prob=float(getattr(word, "probability", 1.0)),
                        )
                    )
            elif job.kind == PARTIAL:
                # Partials decode without word timestamps (10-20% cheaper, and an
                # alignment-head minefield on turbo). LocalAgreement needs tokens,
                # so synthesize them evenly across the segment's span — exact times
                # are only used for the left-trim, where approximate is fine.
                tokens = segment.text.split()
                if tokens:
                    span = max(0.001, float(segment.end - segment.start))
                    for index, token in enumerate(tokens):
                        words.append(WordTok(
                            word=token,
                            start=job.window_start_s + float(segment.start) + index * span / len(tokens),
                            end=job.window_start_s + float(segment.start) + (index + 1) * span / len(tokens),
                            prob=1.0,
                        ))
        decode_ms = (time.monotonic() - started) * 1000.0
        text = " ".join(part for part in text_parts if part).strip()
        with self._metrics_lock:
            self._metrics["decode_ms_total"] += decode_ms
            self._metrics["decode_count"] += 1
            self._metrics["audio_ms_total"] += len(job.audio) / 16.0
        return DecodeResult(
            job=job,
            text=text,
            words=words,
            avg_logprob=(logprob_weighted / logprob_weight) if logprob_weight else -1.0,
            decode_ms=decode_ms,
            segments=file_segments,
        )
