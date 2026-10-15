"""HMAC ticket validation for WebSocket upgrades.

Mirrors `packages/api/lib/wsTicket.ts`. Token format (all URL-safe base64):

    v1.<sessionId>.<expEpochSeconds>.<nonce>.<sig>

where `sig = HMAC_SHA256(secret, "v1|<sessionId>|<exp>|<nonce>")` base64url
encoded without padding. Tickets are short-lived (120 s), single-use (nonce is
burned on first validation), and bound to one recording session.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass

log = logging.getLogger("walfly.auth")

_B64 = base64.urlsafe_b64decode
_NONCE_CACHE_MAX = 10_000


def b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return _B64(value + padding)


@dataclass(frozen=True)
class Ticket:
    session_id: str
    expires_at: float
    nonce: str


class TicketValidator:
    def __init__(self, secret: str | None, *, ttl_slack_s: float = 5.0) -> None:
        self._secret = secret.encode("utf-8") if secret else None
        self._ttl_slack_s = ttl_slack_s
        self._seen_nonces: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return self._secret is not None

    def validate(self, token: str, *, now: float | None = None) -> Ticket | None:
        """Return the ticket payload, or None when invalid/expired/replayed."""
        if self._secret is None:
            log.warning("Rejected WS ticket: WALFLY_WS_SECRET is not configured on the sidecar (restart it after setting the secret)")
            return None
        now = time.time() if now is None else now
        try:
            version, session_b64, exp_raw, nonce, sig = token.split(".")
        except ValueError:
            log.warning("Rejected WS ticket: malformed (expected 5 dot-separated parts)")
            return None
        if version != "v1":
            log.warning("Rejected WS ticket: unsupported version %r", version)
            return None
        try:
            session_id = b64url_decode(session_b64).decode("utf-8")
            expires_at = float(exp_raw)
        except Exception as exc:  # noqa: BLE001 - malformed token is simply invalid
            log.warning("Rejected WS ticket: undecodable session/expiry (%s)", exc)
            return None

        expected = hmac.new(
            self._secret,
            f"v1|{session_id}|{int(expires_at)}|{nonce}".encode("utf-8"),
            hashlib.sha256,
        ).digest()
        try:
            provided = b64url_decode(sig)
        except Exception:  # noqa: BLE001
            log.warning("Rejected WS ticket for session %s: undecodable signature", session_id)
            return None
        if not hmac.compare_digest(expected, provided):
            log.warning(
                "Rejected WS ticket for session %s: signature mismatch — the API and the sidecar "
                "have different WALFLY_WS_SECRET values (or one was not restarted after a change)",
                session_id,
            )
            return None
        if now > expires_at + self._ttl_slack_s:
            log.info("Rejected expired WS ticket for session %s", session_id)
            return None
        if not self._burn_nonce(nonce, now):
            log.info("Rejected replayed WS ticket for session %s", session_id)
            return None
        return Ticket(session_id=session_id, expires_at=expires_at, nonce=nonce)

    def _burn_nonce(self, nonce: str, now: float) -> bool:
        with self._lock:
            if nonce in self._seen_nonces:
                return False
            self._seen_nonces[nonce] = now
            while len(self._seen_nonces) > _NONCE_CACHE_MAX:
                self._seen_nonces.popitem(last=False)
            return True

    @staticmethod
    def ticket_from_subprotocols(subprotocols: list[str]) -> str | None:
        for proto in subprotocols:
            if proto.startswith("ticket."):
                return proto[len("ticket."):]
        return None
