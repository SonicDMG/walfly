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
 * Turns a failed fetch into a message that names the real problem. A bare
 * `TypeError` from fetch means the request never reached the server (wrong
 * host, server down, CORS) — reporting that as "upload failed" is the single
 * most misleading thing this app can say.
 */
export function describeRequestError(err: unknown, what: string): string {
  if (err instanceof TypeError) {
    let base = '<unconfigured>';
    try {
      base = apiBaseUrl();
    } catch {
      return `${what}: ${MISSING_BASE_URL_MESSAGE}`;
    }
    return `${what}: cannot reach the API at ${base}. Check that the Next.js server is running and that EXPO_PUBLIC_API_URL points at it.`;
  }
  if (err instanceof Error) return err.message;
  return `${what}: ${String(err)}`;
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
  PipelineStage,
  ProcessResponse,
  Recording,
  RecordingLocation,
  RecordingPatch,
  RecordingStatus,
  RecordingSummary,
  UploadCapabilities,
  UploadResponse,
} from './types';
