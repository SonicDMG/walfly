"""AudioRing wrap/clip behaviour and ticket validation."""

from __future__ import annotations

import numpy as np

from walfly_asr.auth import TicketValidator
from walfly_asr.ring import AudioRing


def test_ring_roundtrip_and_wrap():
    ring = AudioRing(capacity_samples=10)
    ring.write(np.arange(8, dtype=np.float32))
    assert ring.total_samples == 8
    np.testing.assert_array_equal(ring.read(0, 8), np.arange(8, dtype=np.float32))
    ring.write(np.arange(8, 14, dtype=np.float32))
    assert ring.total_samples == 14
    # Only the newest 10 samples are retained: 4..13.
    overlapping = ring.read(0, 14)
    np.testing.assert_array_equal(overlapping, np.arange(4, 14, dtype=np.float32))


def test_ring_read_clips_to_buffered():
    ring = AudioRing(capacity_samples=100)
    ring.write(np.ones(5, dtype=np.float32))
    assert ring.read(0, 100).shape == (5,)
    assert ring.read(10, 20).shape == (0,)


def test_ring_oversized_write_keeps_tail():
    ring = AudioRing(capacity_samples=4)
    ring.write(np.arange(10, dtype=np.float32))
    np.testing.assert_array_equal(ring.read(6, 10), np.arange(6, 10, dtype=np.float32))


def _mint(secret: str, session_id: str, exp: float, nonce: str) -> str:
    import base64
    import hashlib
    import hmac

    b64 = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")  # noqa: E731
    sig = hmac.new(
        secret.encode(), f"v1|{session_id}|{int(exp)}|{nonce}".encode(), hashlib.sha256
    ).digest()
    return f"v1.{b64(session_id.encode())}.{int(exp)}.{nonce}.{b64(sig)}"


def test_ticket_roundtrip_and_replay_rejection():
    validator = TicketValidator("s3cret")
    token = _mint("s3cret", "rec-123", exp=2_000_000_000, nonce="n1")
    ticket = validator.validate(token, now=1_900_000_000)
    assert ticket is not None and ticket.session_id == "rec-123"
    assert validator.validate(token, now=1_900_000_000) is None  # single-use nonce


def test_ticket_expiry_and_bad_signature():
    validator = TicketValidator("s3cret")
    token = _mint("s3cret", "rec-123", exp=1_000, nonce="n2")
    assert validator.validate(token, now=10_000) is None
    forged = _mint("other", "rec-123", exp=2_000_000_000, nonce="n3")
    assert validator.validate(forged, now=1_900_000_000) is None


def test_ticket_unconfigured_rejects_everything():
    assert TicketValidator(None).validate("anything") is None


def test_ticket_from_subprotocols():
    assert TicketValidator.ticket_from_subprotocols(["walfly.v1", "ticket.abc"]) == "abc"
    assert TicketValidator.ticket_from_subprotocols(["walfly.v1"]) is None
