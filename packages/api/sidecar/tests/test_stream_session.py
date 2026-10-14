"""StreamSession protocol tests.

The VAD and the transcriber are faked, so these tests are fast and
deterministic: they exercise the session state machine (open → partial → close →
segment → ack → bye → final), replay, backpressure drops and hallucination
filtering — everything except the models themselves.
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import replace

import numpy as np

from walfly_asr.agreement import WordTok
from walfly_asr.asr import FINAL, PARTIAL, DecodeJob, DecodeResult
from walfly_asr.config import Settings
from walfly_asr.session import StreamSession

SILENCE_FRAME = np.zeros(1600, dtype=np.float32)
rng = np.random.default_rng(7)
SPEECH_FRAME = rng.uniform(-0.5, 0.5, 1600).astype(np.float32)


class FakeVad:
    """Energy gate rather than Silero: loud frames are speech."""

    def __call__(self, frame: np.ndarray) -> float:
        return 0.9 if float(np.sqrt(np.mean(np.square(frame)))) > 0.1 else 0.05


class FakeTranscriber:
    def __init__(self, final_text: str | None = None) -> None:
        self.final_text = final_text
        self.submitted: list[DecodeJob] = []
        self._lock = threading.Lock()

    def start(self) -> None:  # pragma: no cover - protocol compatibility
        pass

    def shutdown(self) -> None:  # pragma: no cover
        pass

    def submit(self, job: DecodeJob) -> None:
        with self._lock:
            self.submitted.append(job)
        if job.kind == PARTIAL:
            # Stable, growing prefix so LocalAgreement commits progressively.
            seconds = int(job.window_start_s + len(job.audio) / 16000)
            words = [
                WordTok(word=f"p{i}", start=job.window_start_s + i * 0.5, end=job.window_start_s + (i + 1) * 0.5)
                for i in range(max(1, seconds))
            ]
            result = DecodeResult(job=job, text=" ".join(w.word for w in words), words=words,
                                  avg_logprob=-0.2, decode_ms=10.0)
        else:
            words = [
                WordTok(word="final", start=job.window_start_s, end=job.window_start_s + 1.0),
                WordTok(word=f"seg{job.seq}", start=job.window_start_s + 1.0, end=job.window_start_s + 2.0),
            ]
            text = self.final_text if self.final_text is not None else "final seg%d transcript" % job.seq
            result = DecodeResult(job=job, text=text, words=words, avg_logprob=-0.3, decode_ms=15.0)
        job.result_q.put(result)


def make_session(**overrides) -> tuple[StreamSession, list[dict], FakeTranscriber]:
    settings = replace(Settings(), **overrides)
    transcriber = FakeTranscriber()
    collected: list[dict] = []
    session = StreamSession(
        session_id="test-session",
        settings=settings,
        pool=transcriber,
        vad_factory=FakeVad,
        chunk_index_base=100,
    )
    session.set_sink(collected.append)
    return session, collected, transcriber


def feed(session: StreamSession, speech: bool, seconds: float, start_seq: int) -> int:
    frame = SPEECH_FRAME if speech else SILENCE_FRAME
    seq = start_seq
    for _ in range(int(seconds * 10)):
        session.feed_audio(seq, frame)
        seq += 1
        time.sleep(0.004)
    return seq


def wait_for(predicate, timeout: float = 8.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return None


def of_type(messages: list[dict], kind: str) -> list[dict]:
    return [m for m in messages if m.get("t") == kind]


def test_happy_path_partial_segment_ack_final():
    session, collected, _ = make_session()
    session.start()
    seq = feed(session, speech=False, seconds=0.5, start_seq=0)
    seq = feed(session, speech=True, seconds=4.0, start_seq=seq)
    seq = feed(session, speech=False, seconds=1.5, start_seq=seq)

    segment = wait_for(lambda: (of_type(collected, "segment") or [None])[0])
    assert segment is not None, collected
    assert segment["chunkIndex"] == 100 + segment["seq"]
    assert segment["end"] > segment["start"] > 0.0
    assert "final" in segment["text"]

    assert wait_for(lambda: of_type(collected, "partial")), "expected at least one partial"
    assert wait_for(lambda: session.consumed_seq() == seq - 1), session.consumed_seq()

    session.handle_control({"t": "bye"})
    assert session.wait_finished(5.0)
    finals = of_type(collected, "final")
    assert finals and finals[-1]["lastSeq"] >= segment["seq"]


def test_short_utterance_is_dropped():
    session, collected, _ = make_session()
    session.start()
    seq = feed(session, speech=False, seconds=0.2, start_seq=0)
    seq = feed(session, speech=True, seconds=0.5, start_seq=seq)
    feed(session, speech=False, seconds=2.0, start_seq=seq)
    session.handle_control({"t": "bye"})
    assert session.wait_finished(5.0)
    assert of_type(collected, "segment") == []


def test_suspect_final_is_dropped_but_sequence_progresses():
    settings = Settings()
    transcriber = FakeTranscriber(final_text="Thanks for watching!")
    collected: list[dict] = []
    session = StreamSession(session_id="s", settings=settings, pool=transcriber,
                            vad_factory=FakeVad, chunk_index_base=0)
    session.set_sink(collected.append)
    session.start()
    seq = feed(session, speech=False, seconds=0.3, start_seq=0)
    seq = feed(session, speech=True, seconds=2.5, start_seq=seq)
    feed(session, speech=False, seconds=1.5, start_seq=seq)
    session.handle_control({"t": "bye"})
    assert session.wait_finished(5.0)
    assert of_type(collected, "segment") == []
    assert of_type(collected, "final")[-1]["lastSeq"] == 0  # seq was consumed


def test_replay_sends_unacked_then_final():
    session, collected, _ = make_session()
    session.start()
    seq = feed(session, speech=False, seconds=0.3, start_seq=0)
    seq = feed(session, speech=True, seconds=2.5, start_seq=seq)
    feed(session, speech=False, seconds=1.2, start_seq=seq)
    wait_for(lambda: of_type(collected, "segment"))
    session.handle_control({"t": "bye"})
    assert session.wait_finished(5.0)

    replay_stream: list[dict] = []
    session.set_sink(replay_stream.append)
    session.replay(from_seq=-1)
    assert of_type(replay_stream, "segment")
    assert of_type(replay_stream, "final")


def test_backpressure_drops_with_explicit_gap():
    session, collected, _ = make_session(queue_high_ms=1, queue_limit_ms=200, queue_close_ms=10_000)
    # Processor deliberately not started: the queue cannot drain.
    seq = 0
    for _ in range(3):
        session.feed_audio(seq, SILENCE_FRAME)
        seq += 1
    assert session.queue_lag_ms() >= 200  # frame 3 was dropped above the limit
    # Drain the queue by hand, then feed one more frame: the gap is reported.
    drained = 0
    while True:
        try:
            session._audio_q.get_nowait()  # noqa: SLF001 - deterministic test of producer policy
            drained += 1
        except queue.Empty:
            break
    assert drained >= 1
    session.feed_audio(seq, SILENCE_FRAME)
    gaps = of_type(collected, "gap")
    assert gaps and gaps[0]["toMs"] >= gaps[0]["fromMs"]
    assert session.queue_lag_ms() == 100


def test_attached_flag_follows_sink():
    session, _, _ = make_session()
    assert session.attached
    session.set_sink(None)
    assert not session.attached
