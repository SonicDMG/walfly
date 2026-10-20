/**
 * uploadLimits.ts
 *
 * The one place the request-body ceiling lives. Self-hosted (Docker or `next
 * dev`), there's no platform-imposed cap — only this guard. Override via
 * MAX_UPLOAD_BYTES to match a reverse proxy's own body-size limit (e.g. nginx
 * `client_max_body_size`) if one is fronting the API.
 */

const DEFAULT_MAX_UPLOAD_BYTES = 100_000_000;

export function maxUploadBytes(): number {
  const override = Number(process.env.MAX_UPLOAD_BYTES);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_MAX_UPLOAD_BYTES;
}
