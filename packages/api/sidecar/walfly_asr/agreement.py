"""LocalAgreement-2 commit logic, boundary dedupe, and hallucination guards.

Pure functions over token lists so the streaming policy is unit-testable
without a model (see `tests/test_agreement.py`). Times are session-relative
seconds; the session converts worker-relative times before calling here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

_NON_WORD = re.compile(r"^[^\w]+|[^\w]+$", flags=re.UNICODE)

# Whisper's standard hallucination phrases plus the ones observed on silence,
# music and stings in this codebase's recordings.
_BLOCKLIST = (
    "thanks for watching",
    "thank you for watching",
    "subtitles by",
    "subtitle by",
    "please subscribe",
    "like and subscribe",
    "amara.org",
    "transcription by",
    "transcribed by",
    "www.",
    ".com",
)


@dataclass(frozen=True)
class WordTok:
    word: str
    start: float
    end: float
    prob: float = 1.0


def norm_word(word: str) -> str:
    return _NON_WORD.sub("", word.lower())


def common_prefix_len(a: list[str], b: list[str]) -> int:
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i] == b[i]:
        i += 1
    return i


class LocalAgreement:
    """Commit the common prefix of two consecutive hypotheses.

    The committed list only ever grows within one segment; `reset()` starts a
    new segment (the session keeps the previous text as `initial_prompt`).
    """

    def __init__(self) -> None:
        self.committed: list[WordTok] = []
        self._previous: list[list[WordTok]] = []

    def reset(self) -> None:
        self.committed = []
        self._previous = []

    def update(self, hypothesis: list[WordTok]) -> list[WordTok]:
        """Feed the newest hypothesis; return the (possibly unchanged) committed list."""
        norms_new = [norm_word(w.word) for w in hypothesis]
        norms_prev = [norm_word(w.word) for w in self._previous[-1]] if self._previous else []
        agree = common_prefix_len(norms_prev, norms_new)
        if agree > len(self.committed) and agree <= len(hypothesis):
            self.committed = list(hypothesis[:agree])
        self._previous = (self._previous + [hypothesis])[-2:]
        return self.committed


def drop_overlap_words(previous: list[WordTok], incoming: list[WordTok],
                       tolerance_s: float = 0.02) -> list[WordTok]:
    """Remove words at the start of `incoming` that duplicate the previous final.

    Primary rule: word timestamps — anything starting before the previous
    final's last word end (minus tolerance) is a duplicate. Fallback: longest
    common suffix(previous)/prefix(incoming) over normalized words, for when
    the incoming decode has no usable timestamps.
    """
    if not incoming:
        return []
    if not previous:
        return list(incoming)
    cutoff = previous[-1].end - tolerance_s
    kept = [w for w in incoming if w.start >= cutoff]
    if kept:
        return kept
    return incoming[_longest_suffix_prefix_overlap(previous, incoming):]


def _longest_suffix_prefix_overlap(previous: list[WordTok], incoming: list[WordTok]) -> int:
    a = [norm_word(w.word) for w in previous]
    b = [norm_word(w.word) for w in incoming]
    if not a or not b:
        return 0
    matcher = SequenceMatcher(None, a, b, autojunk=False)
    best = 0
    for block in matcher.get_matching_blocks():
        if block.a + block.size == len(a):  # suffix of previous...
            best = max(best, block.size)   # ...matched somewhere; bound by prefix below
    # Cap at the longest true prefix of `incoming`.
    overlap = 0
    for size in range(min(best, len(b)), 0, -1):
        if a[-size:] == b[:size]:
            overlap = size
            break
    return overlap


def is_suspect_text(text: str, *, previous_text: str | None = None) -> bool:
    """True when a final should be dropped as a hallucination/duplicate."""
    cleaned = " ".join(text.split())
    if not cleaned:
        return True
    lowered = cleaned.lower()
    if any(phrase in lowered for phrase in _BLOCKLIST):
        return True
    words = [w for w in re.split(r"\s+", lowered) if w]
    if len(words) >= 3 and len(set(words)) == 1:
        return True
    if len(lowered) <= 2 and not any(ch.isalnum() for ch in lowered):
        return True
    if previous_text is not None:
        if " ".join(previous_text.split()).lower() == lowered:
            return True
    return False


def prompt_tail(texts: list[str], limit: int = 150) -> str:
    """Last `limit` characters of committed text, flattened for initial_prompt."""
    joined = " ".join(" ".join(t.split()) for t in texts if t)
    tail = joined[-limit:]
    # Never start a prompt mid-word.
    if len(joined) > limit and " " in tail:
        tail = tail.split(" ", 1)[1]
    return tail.strip()
