/**
 * wsTicket.ts
 *
 * Mints the short-lived HMAC ticket the client presents when opening a
 * WebSocket to the ASR sidecar. Mirrors `walfly_asr/auth.py` exactly — the
 * token format is `v1.<sessionId>.<expEpochSeconds>.<nonce>.<sig>` with
 * `sig = base64url(HMAC_SHA256(secret, "v1|<sessionId>|<exp>|<nonce>"))`.
 *
 * Tickets travel in the `Sec-WebSocket-Protocol` header (browsers cannot set
 * `Authorization` on a WebSocket, and query-string tokens leak into logs), are
 * bound to one recording id, and expire in two minutes. The sidecar holds this
 * one secret and no other credentials.
 */

import crypto from 'node:crypto';

const TICKET_TTL_S = 120;

export interface WsTicket {
  ticket: string;
  url: string;
  /** Epoch milliseconds when the ticket stops being accepted. */
  expiresAt: number;
}

export function mintWsTicket(sessionId: string): WsTicket {
  const secret = process.env.WALFLY_WS_SECRET;
  if (!secret) {
    throw new Error(
      'WALFLY_WS_SECRET is not configured — set it in packages/api/.env.local ' +
        'and on the sidecar host (same value in both places).',
    );
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_S;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`v1|${sessionId}|${expiresAt}|${nonce}`)
    .digest('base64url');
  const sessionB64 = Buffer.from(sessionId, 'utf8').toString('base64url');

  return {
    ticket: `v1.${sessionB64}.${expiresAt}.${nonce}.${signature}`,
    url: sidecarWsUrl(),
    expiresAt: expiresAt * 1000,
  };
}

/**
 * Where the client should open the audio socket. Kept server-side so the
 * mobile app only needs EXPO_PUBLIC_API_URL (the ticket response carries the
 * URL); local dev defaults to the sidecar's default port.
 */
export function sidecarWsUrl(): string {
  const configured = process.env.SIDECAR_WS_URL?.trim();
  if (configured) return configured;
  return 'ws://localhost:8888/v1/stream';
}
