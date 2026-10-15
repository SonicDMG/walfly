"""LocalAgreement-2, overlap dedupe and hallucination guard tests."""

from __future__ import annotations

from walfly_asr.agreement import (
    LocalAgreement,
    WordTok,
    common_prefix_len,
    drop_overlap_words,
    is_suspect_text,
    prompt_tail,
)


def words(*items: str, start: float = 0.0, step: float = 0.4) -> list[WordTok]:
    return [
        WordTok(word=item, start=start + index * step, end=start + (index + 1) * step)
        for index, item in enumerate(items)
    ]


def test_common_prefix_len():
    assert common_prefix_len(["a", "b"], ["a", "b", "c"]) == 2
    assert common_prefix_len(["a", "x"], ["a", "b"]) == 1
    assert common_prefix_len([], ["a"]) == 0


def test_local_agreement_commits_on_second_identical_hypothesis():
    la = LocalAgreement()
    assert la.update(words("hello", "there")) == []
    committed = la.update(words("hello", "there"))
    assert [w.word for w in committed] == ["hello", "there"]


def test_local_agreement_committed_never_shrinks():
    la = LocalAgreement()
    first = words("the", "quick", "brown")
    second = words("the", "quick", "brown", "fox")
    third = words("the", "quick", "box")  # model rewrote a committed word
    la.update(first)
    la.update(second)
    committed_after = [w.word for w in la.update(third)]
    assert committed_after == ["the", "quick", "brown"]


def test_local_agreement_normalizes_punctuation():
    la = LocalAgreement()
    la.update(words("Hello,", "world."))
    committed = la.update(words("hello", "world"))
    assert len(committed) == 2


def test_drop_overlap_words_by_timestamp():
    previous = [WordTok("meeting", 10.0, 10.5), WordTok("tomorrow", 10.5, 11.0)]
    incoming = [
        WordTok("tomorrow", 10.5, 11.0),   # starts before prev end → duplicate, dropped
        WordTok("at", 11.1, 11.3),
        WordTok("noon", 11.3, 11.6),
    ]
    kept = drop_overlap_words(previous, incoming)
    assert [w.word for w in kept] == ["at", "noon"]


def test_drop_overlap_words_drops_duplicate_start():
    previous = [WordTok("see", 10.0, 10.3), WordTok("you", 10.3, 10.6)]
    incoming = [WordTok("you", 10.3, 10.6), WordTok("soon", 10.7, 11.0)]
    assert [w.word for w in drop_overlap_words(previous, incoming)] == ["soon"]


def test_drop_overlap_words_falls_back_to_text_alignment():
    previous = words("we", "should", "ship", "it")
    incoming = words("ship", "it", "friday")  # timestamps overlap entirely
    kept = drop_overlap_words(previous, incoming)
    assert [w.word for w in kept] == ["friday"]


def test_suspect_text_blocklist_and_repeats():
    assert is_suspect_text("Thanks for watching!") is True
    assert is_suspect_text("Subtitles by the Amara.org community") is True
    assert is_suspect_text("you you you") is True
    assert is_suspect_text("") is True
    assert is_suspect_text(".") is True


def test_suspect_text_duplicate_of_previous():
    assert is_suspect_text("Let's ship it", previous_text="let's  ship it ") is True
    assert is_suspect_text("Let's ship it", previous_text="Let's go home") is False


def test_prompt_tail_is_bounded_and_word_aligned():
    tail = prompt_tail(["hello world " * 30], limit=40)
    assert len(tail) <= 40
    assert not tail.startswith(" ")
    assert " " not in tail[:1]
