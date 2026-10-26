/**
 * api.ts
 *
 * Base URL resolution, request-error reporting, and a single import site for
 * the wire types, which live in ./types and are re-exported at the bottom.
 *
 * `localhost` only makes sense as a default on Expo web. On a phone it resolves
 * to the phone itself, so native throws a loud, actionable error instead of
 * silently failing every request with "Network request failed".
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const API_TOKEN_KEY = 'walfly_api_token';

/** undefined = not loaded from SecureStore yet; null = loaded, no token set. */
let cachedToken: string | null | undefined;

/** Reads the shared API bearer token, from cache after the first call. */
export async function getApiToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = (await SecureStore.getItemAsync(API_TOKEN_KEY)) ?? null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

/** Persists (or clears, with `null`) the shared API bearer token. */
export async function setApiToken(token: string | null): Promise<void> {
  cachedToken = token;
  try {
    if (token) {
      await SecureStore.setItemAsync(API_TOKEN_KEY, token);
    } else {
      await SecureStore.deleteItemAsync(API_TOKEN_KEY);
    }
  } catch (err) {
    console.warn('[api] failed to persist the API token:', err);
  }
}

/**
 * `fetch` with the shared bearer token attached, if one is set. The one
 * import site every request in this app should go through — the API gates
 * every route except /api/health behind this token.
 *
 * Accepts an alternate fetch implementation for callers that need one (e.g.
 * `expo/fetch` on native for a real streaming ReadableStream in useChat.ts).
 */
export async function apiFetch(
  url: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const token = await getApiToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetchImpl(url, { ...init, headers });
}

const MISSING_BASE_URL_MESSAGE =
  'EXPO_PUBLIC_API_URL is not set. Create apps/mobile/.env with ' +
  'EXPO_PUBLIC_API_URL=http://<your-machine-LAN-IP>:3000 (use 10.0.2.2 on the Android ' +
  'emulator) and restart the Expo dev server. "localhost" resolves to the phone itself ' +
  'on a physical device, so there is no usable default here.';

let cachedBaseUrl: string | null = null;

/** Resolves the API origin. Throws on native when EXPO_PUBLIC_API_URL is unset. */
export function apiBaseUrl(): string {
  if (cachedBaseUrl) return cachedBaseUrl;

  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configured) {
    const normalized = configured.replace(/\/+$/, '');
    cachedBaseUrl = normalized;
    return normalized;
  }

  if (Platform.OS === 'web') {
    cachedBaseUrl = 'http://localhost:3000';
    return cachedBaseUrl;
  }

  throw new Error(MISSING_BASE_URL_MESSAGE);
}

export function apiUrl(path: string): string {
  return `${apiBaseUrl()}${path}`;
}

/**
 * Resolves an `audioUrl` from the API. Vercel Blob returns an absolute URL;
 * local dev returns `/api/recordings/audio/<name>`, which is relative to the
 * API origin, never to the Expo dev server.
 */
export function resolveAudioUrl(audioUrl: string): string {
  return /^https?:\/\//i.test(audioUrl) ? audioUrl : apiUrl(audioUrl);
}

/**
 * Custom error thrown when Astra DB is actively waking from hibernation.
 */
export class DatabaseHibernatingError extends Error {
  readonly isHibernating = true;
  readonly retryAfterSeconds: number;

  constructor(message = 'Your database is resuming from hibernation and will be available in a few moments.', retryAfterSeconds = 10) {
    super(message);
    this.name = 'DatabaseHibernatingError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Checks whether an error is a DatabaseHibernatingError or carries hibernation indicators.
 */
export function isHibernationError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof DatabaseHibernatingError) return true;
  if ((err as { isHibernating?: boolean }).isHibernating === true) return true;
  const msg = typeof err === 'string'
    ? err
    : (err as { message?: string }).message || String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('resuming from hibernation') ||
    lower.includes('database_hibernated') ||
    lower.includes('database is hibernated') ||
    lower.includes('hibernating')
  );
}

/**
 * Turns a failed fetch into a message that names the real problem. A bare
 * `TypeError` from fetch means the request never reached the server (wrong
 * host, server down, CORS) — reporting that as "upload failed" is the single
 * most misleading thing this app can say.
 */
export function describeRequestError(err: unknown, what: string): string {
  if (isHibernationError(err)) {
    return 'Database is waking up from sleep. It will be ready in a few moments.';
  }
  if (err instanceof TypeError) {
    try {
      apiBaseUrl(); // validate it is configured; throws if not
    } catch {
      return `${what}: ${MISSING_BASE_URL_MESSAGE}`;
    }
    // Don't include the internal base URL in user-visible strings (CWE-209)
    return `${what}: cannot reach the API. Check that the Next.js server is running.`;
  }
  if (err instanceof Error) return err.message;
  return `${what}: ${String(err)}`;
}

// ─── Streaming session helpers ───────────────────────────────────────────────

/** 201 body of POST /api/recordings/{id}/ws-ticket */
export interface StreamTicketResponse {
  ticket: string;
  url: string;
  /** Epoch milliseconds when the ticket stops being accepted. */
  expiresAt: number;
}

/** Body of POST /api/recordings/{id}/segments */
export interface SegmentPayload {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
}

/** Mints a short-lived ticket for the ASR sidecar WebSocket. */
export async function fetchWsTicket(recordingId: string): Promise<StreamTicketResponse> {
  const res = await apiFetch(apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/ws-ticket`), {
    method: 'POST',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Could not start streaming (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as StreamTicketResponse;
}

/** Checkpoints one finalized streamed segment. Resolves only on a 2xx. */
export async function postSegment(recordingId: string, segment: SegmentPayload): Promise<void> {
  const res = await apiFetch(apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/segments`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(segment),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Segment checkpoint failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// ─── Wire types ──────────────────────────────────────────────────────────────
// Defined in ./types and re-exported here so every screen and hook has a single
// import site for both the transport helpers and the shapes they carry.

export {
  NON_TERMINAL_STATUSES,
  isNonTerminal,
} from './types';

export type {
  ApiError,
  ChunkStatus,
  ClusteredMomentsResponse,
  MomentCluster,
  PipelineStage,
  ProcessResponse,
  Recording,
  RecordingChunk,
  RecordingLocation,
  RecordingPatch,
  RecordingStatus,
  RecordingSummary,
  UploadCapabilities,
  UploadResponse,
} from './types';
