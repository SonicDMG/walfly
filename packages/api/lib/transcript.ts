/**
 * transcript.ts
 *
 * The transcript markdown contract, on the API side. Streaming segments arrive
 * as (startMs, endMs, text); each stored line is
 * `[time: m:ss.s-m:ss.s] text`, byte-for-byte the same format the Python
 * sidecar's `markdown.py` renders for the file path, so both producers write
 * one consistent transcript.
 */

export function fmtTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function formatSegmentLine(startMs: number, endMs: number, text: string): string {
  const start = fmtTime(startMs / 1000);
  const end = fmtTime(Math.max(endMs, startMs) / 1000);
  return `[time: ${start}-${end}] ${text.trim()}`;
}
