/**
 * recoverPolicy.ts
 *
 * Pure policy for the local-buffer recovery path: names, limits, and the single
 * rule that decides whether a recovered recording keeps the transcript the
 * sidecar already streamed or is transcribed again from the uploaded file.
 *
 * Deliberately dependency-free so the decision can be reasoned about (and unit
 * tested) without the database or storage in scope. The stateful half lives in
 * `lib/recover.ts`.
 */

export type TranscriptSource = 'stream' | 'batch';
export type RecoverPreference = 'auto' | 'stream' | 'batch';

/** Hard ceiling for a recovered file; a 15-minute PCM session is ~29 MB. */
export const RECOVER_MAX_BYTES = 64 * 1024 * 1024;

/** Minimal audio extension set shared by the probe, token guard, and complete. */
export const RECOVER_EXTENSIONS = ['wav', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'mp3', 'flac', 'webm'] as const;

export function normalizeExt(ext: string | null | undefined): string {
  const candidate = (ext ?? '').replace(/^\./, '').toLowerCase();
  return (RECOVER_EXTENSIONS as readonly string[]).includes(candidate) ? candidate : 'wav';
}

/** Deterministic, create-only object path — one object per recording, forever. */
export function recoverPathname(recordingId: string, ext: string): string {
  return `recordings/${recordingId}.${normalizeExt(ext)}`;
}

export function isRecoverPathnameFor(recordingId: string, pathname: string): boolean {
  if (!pathname.startsWith(`recordings/${recordingId}.`)) return false;
  if (pathname.includes('..')) return false;
  const ext = pathname.slice(pathname.lastIndexOf('.') + 1);
  return (RECOVER_EXTENSIONS as readonly string[]).includes(ext);
}

/** "Small" gaps: keep the streamed transcript rather than paying for a re-run. */
export const GAP_TOLERANCE_MS = 5_000;
/** Streamed duration must cover at least this fraction of the local file. */
export const COVERAGE_MIN = 0.95;

export interface TranscriptSourceInput {
  /** The stitched transcript the live pipeline wrote from sidecar segments. */
  stitched: string | null;
  receivedChunks: number;
  /** Client-estimated audio the sidecar never consumed (unacked + dropped frames). */
  gapMs: number | null;
  /** Duration of the live session as finalized (0 when that never happened). */
  streamedDuration: number;
  /** Duration measured from the local buffer file. */
  localDuration: number;
  prefer: RecoverPreference;
}

/**
 * Applied exactly once, at attach time. A wrong answer costs either a slightly
 * gappier transcript or one extra ASR run — the same trust level the API
 * already extends to /segments — so the rule stays simple and observable.
 */
export function chooseTranscriptSource(input: TranscriptSourceInput): TranscriptSource {
  if (!input.stitched?.trim() || input.receivedChunks === 0) return 'batch';
  if (input.prefer === 'batch') return 'batch';
  if (input.prefer === 'stream') return 'stream';
  const coverage = input.localDuration > 0 ? input.streamedDuration / input.localDuration : 0;
  return (input.gapMs ?? Number.POSITIVE_INFINITY) <= GAP_TOLERANCE_MS && coverage >= COVERAGE_MIN
    ? 'stream'
    : 'batch';
}
