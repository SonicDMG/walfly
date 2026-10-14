"""AsrPool failure containment and result mapping.

The pool must never wedge a session: a broken model load or a throwing decode
degrades to an empty result, and the session's own final-timeout is the second
line of defence.
"""

from __future__ import annotations

import queue
from dataclasses import replace

import numpy as np
import pytest

from walfly_asr.asr import FILE, DecodeJob, AsrPool
from walfly_asr.config import Settings


class _FakeWord:
    def __init__(self, word, start, end, probability=0.9):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class _FakeSegment:
    def __init__(self, text, start, end, avg_logprob=-0.2, words=None):
        self.text = text
        self.start = start
        self.end = end
        self.avg_logprob = avg_logprob
        self.words = words


class _FakeModel:
    def transcribe(self, audio, **kwargs):  # noqa: ARG002 - signature match
        segments = [
            _FakeSegment(" Hello world.", 0.0, 1.2, words=[
                _FakeWord(" Hello", 0.1, 0.6),
                _FakeWord(" world.", 0.6, 1.2),
            ]),
            _FakeSegment(" Second line.", 1.3, 2.0, words=[
                _FakeWord(" Second", 1.3, 1.6),
                _FakeWord(" line.", 1.6, 2.0),
            ]),
        ]
        return iter(segments), None


def test_degraded_pool_answers_empty_instead_of_wedging():
    settings = replace(Settings(), workers=1)

    def broken_factory():
        raise RuntimeError("model files are missing")

    pool = AsrPool(settings, model_factory=broken_factory)
    pool.start()
    try:
        results: "queue.Queue" = queue.Queue()
        for _ in range(2):  # second job proves it does not sleep between retries
            pool.submit(DecodeJob(
                session_id="degraded",
                kind=FILE,
                audio=np.zeros(1600, dtype=np.float32),
                result_q=results,
            ))
        for _ in range(2):
            result = results.get(timeout=5)
            assert result.text == ""
            assert result.words == []
            assert result.avg_logprob == -1.0
    finally:
        pool.shutdown()


def test_decode_maps_file_segments_and_words_with_window_offset():
    pool = AsrPool(Settings(), model_factory=lambda: _FakeModel())
    job = DecodeJob(
        session_id="mapping",
        kind=FILE,
        audio=np.zeros(32000, dtype=np.float32),
        result_q=queue.Queue(),
        window_start_s=10.0,
    )
    result = pool._decode(_FakeModel(), job)  # noqa: SLF001 - direct unit exercise

    assert [s["text"] for s in result.segments] == ["Hello world.", "Second line."]
    assert result.segments[0]["start"] == pytest.approx(10.0)
    assert result.segments[1]["end"] == pytest.approx(12.0)
    # Words are converted to session time by adding window_start_s.
    assert result.words[0].word.strip() == "Hello"
    assert result.words[0].start == pytest.approx(10.1)
    assert result.words[-1].end == pytest.approx(12.0)
