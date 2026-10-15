"""VAD segmentation state machine tests — probabilities in, events out."""

from __future__ import annotations

import pytest

from walfly_asr.vad import ForceCut, Open, SegmentClosed, VadConfig, VadSegmenter

FRAME_MS = 32.0


def feed(segmenter: VadSegmenter, probs: list[float], start_s: float = 0.0) -> list:
    events = []
    now = start_s
    for prob in probs:
        now += FRAME_MS / 1000.0
        event = segmenter.process(prob, now)
        if event is not None:
            events.append(event)
    return events


HIGH, LOW = 0.9, 0.05
MID = 0.4  # >= end_threshold (0.35), < start_threshold (0.5)


def test_silence_never_opens():
    segmenter = VadSegmenter()
    assert feed(segmenter, [LOW] * 100) == []
    assert not segmenter.is_open


def test_single_high_frame_does_not_open():
    segmenter = VadSegmenter()
    feed(segmenter, [HIGH])
    assert not segmenter.is_open  # needs 2 consecutive frames


def test_opens_on_confirmed_speech():
    segmenter = VadSegmenter()
    events = feed(segmenter, [LOW] * 10 + [HIGH, HIGH])
    assert any(isinstance(event, Open) for event in events)
    assert segmenter.is_open


def test_cut_on_prolonged_high_frame():
    segmenter = VadSegmenter()
    events = feed(segmenter, [LOW] * 10 + [HIGH])
    feed(segmenter, [LOW])
    assert not segmenter.is_open  # confirm counter reset by the low frame


def test_short_burst_is_dropped():
    segmenter = VadSegmenter()
    probs = [LOW] * 10 + [HIGH] * 10 + [LOW] * 40  # ~0.3 s of speech
    events = feed(segmenter, probs)  # below open_speech_ms → no closed segment
    assert not any(isinstance(e, SegmentClosed) for e in events)
    # It may briefly open (informational Open), but it must end closed.
    assert segmenter.flush() is None


def test_segment_closes_after_silence_with_padding():
    segmenter = VadSegmenter()
    events = feed(segmenter, [LOW] * 10 + [HIGH] * 64 + [LOW] * 40)  # ~2 s speech
    closes = [e for e in events if isinstance(e, SegmentClosed)]
    assert len(closes) == 1
    closed = closes[0]
    assert closed.overlap is False
    # start = confirm time − pre_roll (the 2nd high frame, 0.384 s − 0.3 s);
    # end = last speech frame + post_roll.
    assert closed.start_s == pytest.approx(0.084, abs=0.05)
    assert closed.end_s == pytest.approx((10 + 64) * 0.032 + 0.4, abs=0.15)


def test_hysteresis_keeps_segment_alive():
    segmenter = VadSegmenter()
    feed(segmenter, [LOW] * 10 + [HIGH, HIGH])
    events = feed(segmenter, [MID] * 18)  # 0.576 s below end_threshold → not closed yet
    assert not any(isinstance(e, SegmentClosed) for e in events)
    assert segmenter.is_open


def test_force_cut_and_overlap_flag():
    segmenter = VadSegmenter()
    feed(segmenter, [LOW] * 10 + [HIGH] * 4)
    events = feed(segmenter, [HIGH] * 800)  # ~25.6 s of speech → ForceCut
    force = [e for e in events if isinstance(e, ForceCut)]
    assert len(force) == 1

    closed = segmenter.force_cut(segmenter.last_speech_s)
    assert closed.overlap is False
    assert closed.end_s == pytest.approx(segmenter.last_speech_s, abs=0.05)
    # The segment reopened with overlap; the next close is flagged for dedupe.
    events = feed(segmenter, [HIGH] * 40 + [LOW] * 40)
    closes = [e for e in events if isinstance(e, SegmentClosed)]
    assert closes and closes[0].overlap is True


def test_flush_returns_none_when_never_opened():
    segmenter = VadSegmenter()
    feed(segmenter, [LOW] * 10)
    assert segmenter.flush() is None


def test_flush_closes_open_segment():
    segmenter = VadSegmenter()
    feed(segmenter, [LOW] * 5 + [HIGH] * 64)
    closed = segmenter.flush()
    assert isinstance(closed, SegmentClosed)
    assert closed.overlap is False
    assert not segmenter.is_open


def test_config_is_overridable():
    config = VadConfig(force_cut_s=1.0)
    segmenter = VadSegmenter(config)
    feed(segmenter, [LOW] * 4 + [HIGH] * 4)
    events = feed(segmenter, [HIGH] * 40)
    assert any(isinstance(e, ForceCut) for e in events)
