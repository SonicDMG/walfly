"""One live streaming session.

Threading model (matches streaming-plan.md §4.3):

- The event loop (WebSocket reader) calls `feed_audio`, `handle_control`,
  `set_sink`. Those only enqueue or signal — they never touch session state.
- A single **processor thread** per session owns all mutable state: the audio
  ring, the VAD, the segmenter, LocalAgreement, sequencing and the unacked
  replay ring. It drains control messages, then audio, then decode results.
- Decoding happens on the shared `AsrPool` worker threads; results come back on
  a per-session queue. Partials are latest-wins; finals preserve order and are
  emitted strictly by sequence number.

A session outlives one WebSocket connection: on reconnect the app re-attaches a
sink and replays unacked segments (`seq > from_seq`) before live output resumes.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections import deque
from typing import Callable

import numpy as np

from . import protocol
from .agreement import (
    LocalAgreement,
    WordTok,
    drop_overlap_words,
    is_suspect_text,
    prompt_tail,
)
from .asr import FINAL, PARTIAL, DecodeJob, DecodeResult, Transcriber
from .config import Settings
from .ring import AudioRing
from .vad import FRAME_SAMPLES, Open, ForceCut, SegmentClosed, SileroVadStream, VadSegmenter

log = logging.getLogger("walfly.session")

Sink = Callable[[dict], None]

# Scheduling
_PARTIAL_MIN_INTERVAL_S = 0.8
_PARTIAL_MAX_INTERVAL_S = 2.0
_PARTIAL_CONTEXT_S = 0.3          # re-decode this much before the last commit
_MIN_PARTIAL_WINDOW_S = 1.0
_MIN_SEGMENT_AUDIO_S = 0.5
_QUIET_CUT_WINDOW_S = 3.0
_QUIET_CUT_STEP_S = 0.1


class StreamSession:
    def __init__(
        self,
        *,
        session_id: str,
        settings: Settings,
        pool: Transcriber,
        vad_factory: Callable[[], object] | None = None,
        vad_config=None,
    ) -> None:
        self.session_id = session_id
        self._settings = settings
        self._pool = pool
        self._vad_config = vad_config
        self._vad_factory = vad_factory or (lambda: SileroVadStream())

        # Cross-thread queues
        self._audio_q: "queue.Queue[tuple[int, np.ndarray]]" = queue.Queue()
        self._control_q: "queue.Queue[dict]" = queue.Queue()
        self._results_q: "queue.Queue[DecodeResult]" = queue.Queue()
        self._consumed_seq = -1

        # Sink (swapped on reconnect; guarded by lock)
        self._sink: Sink | None = None
        self._sink_lock = threading.Lock()

        # Processor-thread-only state (created there too, except VAD/segmenter
        # which are cheap to build here and never touched before start()).
        self._ring = AudioRing(settings.sample_rate * 45)
        self._segmenter = VadSegmenter(vad_config)
        self._la = LocalAgreement()
        self._samples_fed = 0
        self._vad_processed = 0
        self._vad_carry = np.empty(0, dtype=np.float32)
        self._frame_rms: deque[tuple[float, float]] = deque()

        self._committed: list[WordTok] = []
        self._committed_until_s = 0.0
        self._segment_gen = 0
        self._partial_pending = False
        self._partial_interval_s = _PARTIAL_MIN_INTERVAL_S
        self._last_partial_submit_s = 0.0
        self._partial_revision = 0
        self._final_texts: list[str] = []           # committed history → prompt tail

        self._next_seq = 0                          # next seq to allocate
        self._next_emit_seq = 0                     # next seq eligible to emit
        self._pending_finals = 0
        self._finals_waiting: dict[int, DecodeResult] = {}
        self._final_started: dict[int, float] = {}  # seq → monotonic start (timeout guard)
        self._abandoned: set[int] = set()           # seqs whose decode never returned
        self._last_final_words: list[WordTok] = []
        self._last_final_text: str | None = None
        self._last_emitted_seq = -1
        self._unacked: deque[tuple[dict, float]] = deque()  # (segment message, monotonic ts)
        self._vad_error_logged = False

        self._stop_requested = threading.Event()
        self._flush_done = False
        self._finished = threading.Event()
        self._thread: threading.Thread | None = None

        # Producer-thread (loop) state
        self._gap_open_ms: int | None = None
        self._gap_pending_end_ms: int = 0
        self._dropped_ms_total = 0
        self._last_flow_emit = 0.0
        self._ack_seq = -1

        self.started_at = time.monotonic()
        self.last_activity = time.monotonic()

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"session-{self.session_id[:8]}", daemon=True)
        self._thread.start()

    def shutdown(self, timeout: float = 5.0) -> None:
        self._stop_requested.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    @property
    def finished(self) -> bool:
        return self._finished.is_set()

    def wait_finished(self, timeout: float) -> bool:
        return self._finished.wait(timeout)

    def set_sink(self, sink: Sink | None) -> None:
        with self._sink_lock:
            self._sink = sink

    @property
    def attached(self) -> bool:
        with self._sink_lock:
            return self._sink is not None

    def consumed_seq(self) -> int:
        """Highest frame seq the processor has fully consumed (ack boundary)."""
        return self._consumed_seq

    def _emit(self, message: dict) -> None:
        with self._sink_lock:
            sink = self._sink
        if sink is None:
            return
        try:
            sink(message)
        except Exception:  # noqa: BLE001 — a dead socket must not kill the processor
            log.debug("sink failed for session %s", self.session_id, exc_info=True)

    # ── producer-side API (event loop thread) ──────────────────────────────
    @property
    def stop_requested(self) -> bool:
        return self._stop_requested.is_set()

    def queue_lag_ms(self) -> int:
        return int(self._audio_q.qsize() * 100)

    def feed_audio(self, seq: int, samples: np.ndarray) -> None:
        """Enqueue one audio frame; drop (with an explicit gap) under overload."""
        if self._stop_requested.is_set() or self._finished.is_set():
            return
        self.last_activity = time.monotonic()
        lag_ms = self.queue_lag_ms()
        if lag_ms >= self._settings.queue_close_ms:
            # The reader checks queue_lag_ms() and closes the socket; keep dropping.
            self._record_drop(100)
            return
        if lag_ms >= self._settings.queue_limit_ms:
            self._record_drop(100)
            return
        if lag_ms >= self._settings.queue_high_ms:
            now = time.monotonic()
            if now - self._last_flow_emit > 1.0:
                self._last_flow_emit = now
                self._emit(protocol.flow(lag_ms, self._settings.queue_limit_ms))
        self._close_gap()
        self._audio_q.put((int(seq), np.asarray(samples, dtype=np.float32).reshape(-1)))

    def _record_drop(self, ms: int) -> None:
        now_ms = int((time.monotonic() - self.started_at) * 1000)
        if self._gap_open_ms is None:
            self._gap_open_ms = now_ms
        self._dropped_ms_total += ms
        # Extend the open gap to now.
        self._gap_pending_end_ms = now_ms

    def _close_gap(self) -> None:
        if self._gap_open_ms is None:
            return
        self._emit(protocol.gap(self._gap_open_ms, self._gap_pending_end_ms))
        self._gap_open_ms = None

    def handle_control(self, message: dict) -> None:
        """Route client control messages; ping is answered immediately."""
        self.last_activity = time.monotonic()
        kind = message.get("t")
        if kind == "ping":
            self._emit(protocol.pong(message.get("t0")))
            return
        if kind in ("ack", "bye"):
            self._control_q.put(message)

    def request_stop(self) -> None:
        self._stop_requested.set()

    def unacked_since(self, from_seq: int) -> list[dict]:
        return [message for message, _ts in list(self._unacked) if message["seq"] > from_seq]

    def snapshot(self) -> dict:
        return {
            "sessionId": self.session_id,
            "finished": self.finished,
            "queueLagMs": self.queue_lag_ms(),
            "nextSeq": self._next_seq,
            "unacked": len(self._unacked),
            "ackedSeq": self._ack_seq,
            "gapMsTotal": self._dropped_ms_total,
            "ageS": round(time.monotonic() - self.started_at, 1),
        }

    # ── processor thread ───────────────────────────────────────────────────
    def _run(self) -> None:
        vad = self._vad_factory()
        self._vad = vad  # kept for tests/debug
        try:
            while True:
                self._drain_controls()
                item = None
                try:
                    item = self._audio_q.get(timeout=0.02)
                except queue.Empty:
                    pass
                if item is not None:
                    seq, frame = item
                    self._on_audio(frame, vad)
                    if seq > self._consumed_seq:
                        self._consumed_seq = seq
                self._drain_results()
                self._abandon_stale_finals()

                if self._stop_requested.is_set():
                    if not self._flush_done and self._audio_q.empty():
                        self._flush()
                    if self._flush_done and self._pending_finals == 0 and not self._finals_waiting:
                        self._finish()
                if self._finished.is_set() and self._audio_q.empty():
                    break
        except Exception:  # noqa: BLE001 — never leave a session half-dead
            log.exception("session %s processor crashed", self.session_id)
            self._finish()
        finally:
            self._finished.set()

    def _drain_controls(self) -> None:
        while True:
            try:
                message = self._control_q.get_nowait()
            except queue.Empty:
                return
            kind = message.get("t")
            if kind == "ack":
                try:
                    seq = int(message.get("seq", -1))
                except (TypeError, ValueError):
                    continue
                if seq > self._ack_seq:
                    self._ack_seq = seq
                    while self._unacked and self._unacked[0][0]["seq"] <= seq:
                        self._unacked.popleft()
            elif kind == "bye":
                self._stop_requested.set()

    # ── audio → VAD → segments ─────────────────────────────────────────────
    def _on_audio(self, pcm: np.ndarray, vad: object) -> None:
        self._samples_fed += len(pcm)
        self._ring.write(pcm)
        if self._vad_carry.size:
            buffer = np.concatenate([self._vad_carry, pcm])
        else:
            buffer = pcm
        windows = len(buffer) // FRAME_SAMPLES
        now_s = self._vad_processed / self._settings.sample_rate
        for index in range(windows):
            window = buffer[index * FRAME_SAMPLES:(index + 1) * FRAME_SAMPLES]
            self._vad_processed += FRAME_SAMPLES
            now_s = self._vad_processed / self._settings.sample_rate
            try:
                probability = float(vad(window))  # type: ignore[operator]
            except Exception:  # noqa: BLE001 — a transient frame error must not kill the session
                if not self._vad_error_logged:
                    log.exception("session %s: VAD frame failed; treating as silence", self.session_id)
                    self._vad_error_logged = True
                probability = 0.0
            self._remember_rms(window, now_s)
            event = self._segmenter.process(probability, now_s)
            if isinstance(event, Open):
                self._on_segment_open()
            elif isinstance(event, ForceCut):
                self._on_force_cut(now_s)
            elif isinstance(event, SegmentClosed):
                self._on_segment_closed(event)
        self._vad_carry = buffer[windows * FRAME_SAMPLES:].copy()
        self._maybe_schedule_partial(now_s)

    def _remember_rms(self, window: np.ndarray, now_s: float) -> None:
        rms = float(np.sqrt(np.mean(np.square(window))) + 1e-9)
        self._frame_rms.append((now_s, rms))
        horizon = now_s - _QUIET_CUT_WINDOW_S
        while self._frame_rms and self._frame_rms[0][0] < horizon:
            self._frame_rms.popleft()

    def _on_segment_open(self) -> None:
        self._segment_gen += 1
        self._la.reset()
        self._committed = []
        self._committed_until_s = self._segmenter.seg_start_s
        self._partial_pending = False
        self._last_partial_submit_s = 0.0

    def _on_segment_closed(self, event: SegmentClosed) -> None:
        self._partial_pending = False
        self._segment_gen += 1  # stale partial results from here on are dropped
        start_s = max(0.0, event.start_s)
        end_s = max(start_s, event.end_s)
        start_sample = int(start_s * self._settings.sample_rate)
        end_sample = int(end_s * self._settings.sample_rate)
        audio = self._ring.read(start_sample, end_sample)
        if len(audio) < _MIN_SEGMENT_AUDIO_S * self._settings.sample_rate:
            log.info("session %s: dropping %.2fs segment (too short)", self.session_id, len(audio) / self._settings.sample_rate)
            return
        seq = self._next_seq
        self._next_seq += 1
        self._pending_finals += 1
        self._final_started[seq] = time.monotonic()
        self._pool.submit(DecodeJob(
            session_id=self.session_id,
            kind=FINAL,
            audio=audio,
            result_q=self._results_q,
            window_start_s=start_s,
            seq=seq,
            overlap=event.overlap,
            initial_prompt=prompt_tail(self._final_texts) or None,
            language=self._settings.language,
        ))

    def _on_force_cut(self, now_s: float) -> None:
        cut_s = self._quiet_cut_point(now_s)
        closed = self._segmenter.force_cut(cut_s)
        self._on_segment_closed(closed)
        self._on_segment_open()

    def _quiet_cut_point(self, now_s: float) -> float:
        frames = list(self._frame_rms)
        best_cut = now_s - 0.5
        best_energy = float("inf")
        # 100 ms window ≈ 3 frames of 32 ms.
        span = max(1, int(_QUIET_CUT_STEP_S / (FRAME_SAMPLES / self._settings.sample_rate)))
        for start in range(0, max(0, len(frames) - span + 1)):
            window = frames[start:start + span]
            energy = sum(rms for _t, rms in window)
            if energy < best_energy:
                best_energy = energy
                best_cut = window[len(window) // 2][0]
        return min(best_cut, now_s)

    def _maybe_schedule_partial(self, now_s: float) -> None:
        if not self._segmenter.is_open or self._partial_pending:
            return
        if self._stop_requested.is_set():
            return
        if self._segmenter.speech_ms < 1000.0:
            return
        if now_s - self._last_partial_submit_s < self._partial_interval_s:
            return
        start_s = max(
            self._committed_until_s - _PARTIAL_CONTEXT_S,
            self._segmenter.seg_start_s,
            self._ring.earliest_sample / self._settings.sample_rate,
        )
        if now_s - start_s < _MIN_PARTIAL_WINDOW_S:
            return
        audio = self._ring.read(int(start_s * self._settings.sample_rate), int(now_s * self._settings.sample_rate))
        if len(audio) == 0:
            return
        self._partial_pending = True
        self._last_partial_submit_s = now_s
        self._pool.submit(DecodeJob(
            session_id=self.session_id,
            kind=PARTIAL,
            audio=audio,
            result_q=self._results_q,
            window_start_s=start_s,
            generation=self._segment_gen,
            initial_prompt=prompt_tail(self._final_texts) or None,
            language=self._settings.language,
        ))

    # ── results ────────────────────────────────────────────────────────────
    def _drain_results(self) -> None:
        while True:
            try:
                result = self._results_q.get_nowait()
            except queue.Empty:
                break
            if result.job.kind == PARTIAL:
                self._handle_partial(result)
            else:
                self._handle_final(result)

    def _handle_partial(self, result: DecodeResult) -> None:
        self._partial_pending = False
        # Adaptive cadence: a slow decode pushes the next partial out.
        self._partial_interval_s = min(
            _PARTIAL_MAX_INTERVAL_S,
            max(_PARTIAL_MIN_INTERVAL_S, 2.0 * result.decode_ms / 1000.0),
        )
        if result.job.generation != self._segment_gen or not self._segmenter.is_open:
            return
        committed = self._la.update(result.words)
        if len(committed) <= len(self._committed):
            return
        self._committed = committed
        self._committed_until_s = committed[-1].end
        self._partial_revision += 1
        text = " ".join(word.word.strip() for word in committed).strip()
        if text:
            self._emit(protocol.partial(self._partial_revision, self._committed_until_s, text))

    def _handle_final(self, result: DecodeResult) -> None:
        seq = result.job.seq
        self._final_started.pop(seq, None)
        if seq < self._next_emit_seq:
            # Already abandoned (worker timeout) or emitted — nothing to record.
            return
        self._pending_finals = max(0, self._pending_finals - 1)
        self._finals_waiting[seq] = result
        self._emit_ready_finals()

    def _abandon_stale_finals(self) -> None:
        """Bound how long one wedged decode can hold a session's `final`."""
        if not self._final_started:
            return
        now = time.monotonic()
        stale = [
            seq for seq, started in self._final_started.items()
            if now - started > self._settings.final_timeout_s
        ]
        for seq in stale:
            started = self._final_started.pop(seq)
            log.error(
                "session %s: abandoning final seq=%d after %.0fs (decode never returned)",
                self.session_id, seq, now - started,
            )
            self._pending_finals = max(0, self._pending_finals - 1)
            self._finals_waiting.pop(seq, None)
            self._abandoned.add(seq)
        if stale:
            self._emit_ready_finals()

    def _emit_ready_finals(self) -> None:
        while self._next_emit_seq in self._finals_waiting or self._next_emit_seq in self._abandoned:
            if self._next_emit_seq in self._abandoned:
                self._abandoned.discard(self._next_emit_seq)
                self._next_emit_seq += 1
                continue
            result = self._finals_waiting.pop(self._next_emit_seq)
            self._next_emit_seq += 1
            self._emit_one_final(result)

    def _emit_one_final(self, result: DecodeResult) -> None:
        job = result.job
        words = result.words
        text = result.text
        if job.overlap and words and self._last_final_words:
            words = drop_overlap_words(self._last_final_words, words)
            if words:
                text = " ".join(word.word.strip() for word in words).strip()
        if is_suspect_text(text, previous_text=self._last_final_text):
            log.info("session %s: dropping suspect/empty final seq=%d (%r)", self.session_id, job.seq, text[:60])
            return
        message = protocol.segment(
            seq=job.seq,
            start_s=job.window_start_s,
            end_s=max(job.window_start_s, job.window_start_s + len(job.audio) / self._settings.sample_rate),
            text=text,
            avg_logprob=result.avg_logprob,
        )
        self._last_final_words = words or self._last_final_words
        self._last_final_text = text
        self._last_emitted_seq = job.seq
        self._final_texts.append(text)
        self._unacked.append((message, time.monotonic()))
        while len(self._unacked) > self._settings.replay_ring_segments:
            self._unacked.popleft()
        replay_cutoff = time.monotonic() - self._settings.replay_ring_ms / 1000.0
        while self._unacked and self._unacked[0][1] < replay_cutoff:
            self._unacked.popleft()
        self._emit(message)

    # ── stop / finish ──────────────────────────────────────────────────────
    def _flush(self) -> None:
        self._flush_done = True
        now_s = self._vad_processed / self._settings.sample_rate
        closed = self._segmenter.flush(now_s)
        if closed is not None:
            self._on_segment_closed(closed)

    def _finish(self) -> None:
        if self._finished.is_set():
            return
        self._emit(protocol.final(self._next_seq - 1))
        self._finished.set()

    # ── replay for reconnects ──────────────────────────────────────────────
    def replay(self, from_seq: int) -> None:
        """Emit unacked segments with seq > from_seq, then re-send final when done."""
        for segment in self.unacked_since(from_seq):
            self._emit(segment)
        if self._finished.is_set():
            self._emit(protocol.final(self._next_seq - 1))
