"""Absolute-index circular buffer of mono float32 audio for one live session.

The session clock is `total_samples / sample_rate`: every sample that arrives is
written once, and every read addresses absolute sample indices. Reads are
copies of only the requested span, so nothing rescans history.
"""

from __future__ import annotations

import numpy as np


class AudioRing:
    def __init__(self, capacity_samples: int) -> None:
        if capacity_samples <= 0:
            raise ValueError("capacity_samples must be positive")
        self._capacity = int(capacity_samples)
        self._buf = np.zeros(self._capacity, dtype=np.float32)
        self._write = 0    # next index in _buf to write
        self._total = 0    # samples ever written

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def total_samples(self) -> int:
        return self._total

    @property
    def earliest_sample(self) -> int:
        return max(0, self._total - self._capacity)

    def write(self, samples: np.ndarray) -> None:
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        n = samples.shape[0]
        if n == 0:
            return
        if n >= self._capacity:
            # Keep only the newest `capacity` samples.
            self._buf[:] = samples[-self._capacity:]
            self._write = 0
            self._total += n
            return
        end = self._write + n
        if end <= self._capacity:
            self._buf[self._write:end] = samples
        else:
            first = self._capacity - self._write
            self._buf[self._write:] = samples[:first]
            self._buf[: end - self._capacity] = samples[first:]
        self._write = end % self._capacity
        self._total += n

    def read(self, start_sample: int, end_sample: int) -> np.ndarray:
        """Return samples [start, end), clipped to what is still buffered."""
        start = max(int(start_sample), self.earliest_sample)
        end = min(int(end_sample), self._total)
        if end <= start:
            return np.empty(0, dtype=np.float32)
        buf_start = (self._write - (self._total - start)) % self._capacity
        count = end - start
        if buf_start + count <= self._capacity:
            return self._buf[buf_start:buf_start + count].copy()
        first = self._capacity - buf_start
        return np.concatenate([self._buf[buf_start:], self._buf[: count - first]])
