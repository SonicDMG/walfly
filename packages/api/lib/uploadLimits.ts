/**
 * uploadLimits.ts
 *
 * The one place the request-body ceiling lives. Vercel rejects a larger body at
 * the routing layer, before the handler runs, with an HTML 413 — a platform
 * limit on the request, not a storage limit — so it applies whenever we are
 * deployed there, regardless of where the bytes end up. A local server has no
 * such cap and needs the headroom.
 */

export function maxUploadBytes(): number {
  return process.env.VERCEL ? 4_000_000 : 100_000_000;
}
