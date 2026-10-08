/**
 * music.ts
 *
 * Music detection via Chromaprint (fpcalc) + AcoustID lookup.
 *
 * Two entry points:
 *
 *   detectMusic(audioUrl)
 *     Used by the pipeline enrichment step for standard (non-live) uploads.
 *     Downloads the full audio file to a temp path, fingerprints it, looks up
 *     AcoustID, cleans up.
 *
 *   detectMusicFromBytes(bytes, filename)
 *     Used by the live-session chunk route. The chunk audio is already in memory
 *     and is about to be discarded, so we write it to a temp file, fingerprint
 *     it, look up AcoustID, and clean up — all before the chunk response returns.
 *     Each non-silent chunk is checked until a match is found, at which point the
 *     caller stops trying (the recording already has music metadata stored).
 *
 * Neither function ever throws — both return { detected: false } on any failure
 * so the pipeline / chunk route always succeeds regardless of music detection.
 *
 * Install fpcalc:
 *   macOS:  brew install chromaprint
 *   Ubuntu: apt install libchromaprint-tools
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { createWriteStream, existsSync, unlink, writeFile } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import type { MusicDetection, MusicMatch } from '@walfly/db';

const execFileAsync = promisify(execFile);

const ACOUSTID_LOOKUP_URL = 'https://api.acoustid.org/v2/lookup';
/** Minimum AcoustID confidence score (0–1) to include a match.
 *  0.3 is intentionally permissive — mic-recorded ambient music degrades the
 *  fingerprint significantly vs a clean file, so we accept weaker matches. */
const MIN_SCORE = 0.3;
/** How long to wait for fpcalc to finish (ms). */
const FPCALC_TIMEOUT_MS = 30_000;
/** How long to wait for the AcoustID HTTP call (ms). */
const ACOUSTID_TIMEOUT_MS = 10_000;

interface FpcalcResult {
  duration: number;
  fingerprint: string;
}

interface AcoustIdRecording {
  id: string;
  title?: string;
  artists?: { name: string }[];
  releasegroups?: { title?: string; 'first-release-date'?: string }[];
}

interface AcoustIdResult {
  id: string;
  score: number;
  recordings?: AcoustIdRecording[];
}

interface AcoustIdResponse {
  status: string;
  results?: AcoustIdResult[];
}

/** Raw audio bytes + filename from a single live-session chunk. */
export interface ChunkBuffer {
  bytes: Uint8Array;
  filename: string;
}

/** Accumulate this many 15s chunks before combined fingerprinting (4 × 15s = 60s). */
export const MUSIC_CHUNK_WINDOW = 4;

// ANSI colour helpers — work in both Next.js dev console and raw Node stdout.
const CYAN    = '\x1b[36m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const BOLD    = '\x1b[1m';
const RESET   = '\x1b[0m';

function musicLog(msg: string)  { console.log(`${CYAN}[music]${RESET} ${msg}`); }
function musicWarn(msg: string) { console.warn(`${YELLOW}[music]${RESET} ${msg}`); }

/**
 * Detects music in a recording by fingerprinting the audio and looking it up
 * against the AcoustID / MusicBrainz database.
 *
 * Never throws — returns { detected: false } on any failure so the enrichment
 * step is never blocked by music detection being unavailable.
 */
export async function detectMusic(audioUrl: string): Promise<MusicDetection> {
  const apiKey = process.env.ACOUSTID_API_KEY?.trim();
  if (!apiKey) {
    musicLog('ACOUSTID_API_KEY not set — skipping music detection');
    return notDetected();
  }

  let tmpFile: string | null = null;
  try {
    musicLog('fingerprinting audio…');
    tmpFile = await downloadToTmp(audioUrl);
    const fp = await runFpcalc(tmpFile);
    musicLog(`fingerprint ready — duration=${fp.duration}s`);
    const matches = await lookupAcoustId(fp, apiKey);
    const detected = matches.length > 0;

    if (detected) {
      console.log(`${BOLD}${GREEN}🎵 MUSIC DETECTED!${RESET}`);
      for (const m of matches) {
        console.log(
          `${BOLD}${MAGENTA}  ♪ "${m.title}" by ${m.artist}` +
          `${m.album ? ` — ${m.album}` : ''}` +
          `${m.releaseDate ? ` (${m.releaseDate.slice(0, 4)})` : ''}` +
          `  [score: ${(m.score * 100).toFixed(0)}%]${RESET}`,
        );
      }
    } else {
      musicLog('no music match found');
    }

    return { detected, matches, scannedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    musicWarn(`detection failed (non-fatal): ${message}`);
    return notDetected();
  } finally {
    if (tmpFile) {
      unlink(tmpFile, () => { /* best-effort cleanup */ });
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function notDetected(): MusicDetection {
  return { detected: false, matches: [], scannedAt: new Date().toISOString() };
}

/**
 * Detects music from raw audio bytes already in memory (e.g. a live session
 * chunk). Writes to a temp file, fingerprints, looks up AcoustID, cleans up.
 * Never throws.
 */
export async function detectMusicFromBytes(
  bytes: Uint8Array,
  filename: string,
): Promise<MusicDetection> {
  const apiKey = process.env.ACOUSTID_API_KEY?.trim();
  if (!apiKey) return notDetected();

  const ext = filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '.audio';
  const tmpFile = join(tmpdir(), `walfly-fp-${randomUUID()}${ext}`);

  try {
    musicLog(`fingerprinting chunk (${(bytes.byteLength / 1024).toFixed(0)} KB)…`);
    await new Promise<void>((resolve, reject) =>
      writeFile(tmpFile, bytes, (err) => (err ? reject(err) : resolve())),
    );
    const fp = await runFpcalc(tmpFile);
    musicLog(`fingerprint ready — duration=${fp.duration}s`);
    const matches = await lookupAcoustId(fp, apiKey);
    const detected = matches.length > 0;

    if (detected) {
      console.log(`${BOLD}${GREEN}🎵 MUSIC DETECTED!${RESET}`);
      for (const m of matches) {
        console.log(
          `${BOLD}${MAGENTA}  ♪ "${m.title}" by ${m.artist}` +
          `${m.album ? ` — ${m.album}` : ''}` +
          `${m.releaseDate ? ` (${m.releaseDate.slice(0, 4)})` : ''}` +
          `  [score: ${(m.score * 100).toFixed(0)}%]${RESET}`,
        );
      }
    } else {
      musicLog('no music match found in chunk');
    }

    return { detected, matches, scannedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    musicWarn(`chunk detection failed (non-fatal): ${message}`);
    return notDetected();
  } finally {
    unlink(tmpFile, () => { /* best-effort cleanup */ });
  }
}

/**
 * Combines multiple audio chunks into a single buffer before fingerprinting.
 * Individual 15-second chunks are too short for reliable AcoustID matching,
 * so we concatenate 4 chunks (≈60 s) to produce a stronger fingerprint.
 * Never throws — returns { detected: false } on any failure.
 */
export async function detectMusicFromChunks(chunks: ChunkBuffer[]): Promise<MusicDetection> {
  const apiKey = process.env.ACOUSTID_API_KEY?.trim();
  if (!apiKey) return notDetected();

  let combinedPath: string | null = null;
  try {
    const totalBytes = chunks.reduce((sum, c) => sum + c.bytes.byteLength, 0);
    musicLog(`fingerprinting combined buffer (${chunks.length} chunks, ${(totalBytes / 1024).toFixed(0)} KB)…`);

    combinedPath = await concatAudioToWav(chunks);
    const fp = await runFpcalc(combinedPath);
    musicLog(`fingerprint ready — duration=${fp.duration}s`);
    const matches = await lookupAcoustId(fp, apiKey);
    const detected = matches.length > 0;

    if (detected) {
      console.log(`${BOLD}${GREEN}🎵 MUSIC DETECTED! (combined ${chunks.length} chunks)${RESET}`);
      for (const m of matches) {
        console.log(
          `${BOLD}${MAGENTA}  ♪ "${m.title}" by ${m.artist}` +
          `${m.album ? ` — ${m.album}` : ''}` +
          `${m.releaseDate ? ` (${m.releaseDate.slice(0, 4)})` : ''}` +
          `  [score: ${(m.score * 100).toFixed(0)}%]${RESET}`,
        );
      }
    } else {
      musicLog('no music match found in combined chunks');
    }

    return { detected, matches, scannedAt: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    musicWarn(`combined detection failed (non-fatal): ${message}`);
    return notDetected();
  } finally {
    if (combinedPath) {
      unlink(combinedPath, () => { /* best-effort cleanup */ });
    }
  }
}

/**
 * Writes each chunk to a temp file, transcodes to 16 kHz mono PCM WAV via
 * ffmpeg, then concatenates all WAVs into a single combined file using ffmpeg's
 * concat demuxer. Returns the path to the combined WAV. All intermediate files
 * are cleaned up in the finally block; the caller owns the combined file.
 */
async function concatAudioToWav(chunks: ChunkBuffer[]): Promise<string> {
  const tempFiles: string[] = [];
  const wavFiles: string[] = [];
  const combinedPath = join(tmpdir(), `walfly-fp-combined-${randomUUID()}.wav`);
  const listFile = join(tmpdir(), `walfly-fp-list-${randomUUID()}.txt`);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const { bytes, filename } = chunks[i];
      const ext = filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '.audio';
      const tmpPath = join(tmpdir(), `walfly-fp-chunk-${randomUUID()}${ext}`);
      tempFiles.push(tmpPath);

      await new Promise<void>((resolve, reject) =>
        writeFile(tmpPath, bytes, (err) => (err ? reject(err) : resolve())),
      );

      const wavPath = tmpPath.replace(/\.[^.]+$/, '') + '-pcm.wav';
      try {
        await execFileAsync('ffmpeg', [
          '-y',                       // overwrite output
          '-i', tmpPath,              // input: raw chunk
          '-ar', '16000',             // 16 kHz — enough for fingerprinting
          '-ac', '1',                 // mono
          '-f', 'wav',
          wavPath,
        ], { timeout: FPCALC_TIMEOUT_MS });
        wavFiles.push(wavPath);
      } catch (err) {
        // ffmpeg not available or decode failed — fall back to passing the
        // raw chunk file directly to the concat demuxer and hope for the best.
        musicWarn(`ffmpeg transcode for chunk ${i} failed, using raw file: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
        wavFiles.push(tmpPath);
      }
    }

    // Build the concat demuxer file list
    const listContent = wavFiles
      .map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      .join('\n');
    await new Promise<void>((resolve, reject) =>
      writeFile(listFile, listContent, (err) => (err ? reject(err) : resolve())),
    );

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listFile,
      '-ar', '16000', '-ac', '1', '-f', 'wav',
      combinedPath,
    ], { timeout: FPCALC_TIMEOUT_MS });

    return combinedPath;
  } finally {
    for (const f of [...tempFiles, ...wavFiles, listFile]) {
      unlink(f, () => { /* best-effort cleanup */ });
    }
  }
}

// ── Chunk accumulation for combined detection ────────────────────────────────
//
// A module-level accumulator: in `next dev` (single long-running process) the
// Map persists across chunk uploads, so we can stitch 4×15 s chunks into a 60 s
// buffer before fingerprinting. In cold-start serverless each invocation starts
// fresh; the chunk route falls back to per-chunk detection in that case.

const chunkMusicBuffers = new Map<string, ChunkBuffer[]>();
const musicDetectedRecordings = new Set<string>();

/**
 * Adds a chunk to the per-recording accumulator and reports what should be
 * fingerprinted. Returns:
 *  - `combined`: 4 accumulated chunks ready for `detectMusicFromChunks` (or null)
 *  - `single`: the single chunk to fall back to `detectMusicFromBytes` (or null)
 *  - `skip`: true if music was already detected for this recording
 */
export function addChunkToMusicBuffer(
  recordingId: string,
  chunk: ChunkBuffer,
): { combined: ChunkBuffer[] | null; single: ChunkBuffer | null; skip: boolean } {
  if (musicDetectedRecordings.has(recordingId)) {
    return { combined: null, single: null, skip: true };
  }

  const buffer = chunkMusicBuffers.get(recordingId);
  if (!buffer || buffer.length === 0) {
    // First chunk for this recording (or buffer was flushed) — seed it and
    // flag the caller to also run per-chunk detection as a fast fallback.
    chunkMusicBuffers.set(recordingId, [chunk]);
    return { combined: null, single: chunk, skip: false };
  }

  buffer.push(chunk);
  if (buffer.length >= MUSIC_CHUNK_WINDOW) {
    return { combined: buffer.splice(0, MUSIC_CHUNK_WINDOW), single: null, skip: false };
  }

  return { combined: null, single: null, skip: false };
}

/** Called when music is detected — clears the buffer and stops future detection
 *  for this recording (avoids redundant fpcalc/ffmpeg work). */
export function markMusicDetected(recordingId: string): void {
  musicDetectedRecordings.add(recordingId);
  chunkMusicBuffers.delete(recordingId);
}

/** Returns and clears any leftover accumulated chunks (e.g. on session
 *  finalization when fewer than 4 chunks remain in the buffer). */
export function flushMusicBuffer(recordingId: string): ChunkBuffer[] {
  const buffer = chunkMusicBuffers.get(recordingId);
  chunkMusicBuffers.delete(recordingId);
  return buffer ?? [];
}


/**
 * Downloads the audio to a temp file. fpcalc only accepts a file path, not
 * a stream or URL. For local dev paths (/api/recordings/audio/...) we resolve
 * them against the API base URL derived from the process environment.
 */
async function downloadToTmp(audioUrl: string): Promise<string> {
  const url = audioUrl.startsWith('http')
    ? audioUrl
    : `http://localhost:${process.env.PORT ?? 3000}${audioUrl}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download audio for fingerprinting: HTTP ${response.status}`);
  }

  const ext = url.includes('.m4a') ? '.m4a' : '.audio';
  const dest = join(tmpdir(), `walfly-fp-${randomUUID()}${ext}`);

  const fileStream = createWriteStream(dest);
  await pipeline(response.body as unknown as NodeJS.ReadableStream, fileStream);

  return dest;
}

/**
 * Spawns `fpcalc -json <file>` and parses the JSON output.
 * Throws a descriptive error if fpcalc is not found on PATH.
 */
async function runFpcalc(filePath: string): Promise<FpcalcResult> {
  // Transcode to PCM WAV first so fpcalc always receives clean, unambiguous
  // audio regardless of whether the browser produced WebM, MP4, Ogg, etc.
  // Safari labels its MediaRecorder output as audio/mp4 but the container
  // often confuses fpcalc's FFmpeg decoder; WAV never does.
  const wavPath = filePath.replace(/\.[^.]+$/, '') + '-pcm.wav';
  try {
    await execFileAsync('ffmpeg', [
      '-y',                       // overwrite output
      '-i', filePath,             // input: whatever the browser sent
      '-ar', '16000',             // 16 kHz — enough for fingerprinting
      '-ac', '1',                 // mono
      '-f', 'wav',
      wavPath,
    ], { timeout: FPCALC_TIMEOUT_MS });
  } catch (err) {
    // ffmpeg not available or decode failed — fall back to passing the
    // original file directly to fpcalc and hope for the best.
    musicWarn(`ffmpeg transcode failed, trying fpcalc directly: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
  }

  const inputPath = existsSync(wavPath) ? wavPath : filePath;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('fpcalc', ['-json', inputPath], {
      timeout: FPCALC_TIMEOUT_MS,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT') || message.includes('not found')) {
      throw new Error(
        'fpcalc not found on PATH — install Chromaprint (brew install chromaprint / apt install libchromaprint-tools)',
      );
    }
    throw new Error(`fpcalc failed: ${message}`);
  } finally {
    // Clean up the wav regardless of success or failure
    unlink(wavPath, () => {});
  }

  const parsed = JSON.parse(stdout.trim()) as {
    duration?: number; fingerprint?: string;   // fpcalc 1.5+ (lowercase)
    DURATION?: number; FINGERPRINT?: string;   // fpcalc < 1.5 (uppercase)
  };
  const dur = parsed.duration ?? parsed.DURATION;
  const fp  = parsed.fingerprint ?? parsed.FINGERPRINT;
  if (!dur || !fp) {
    throw new Error(`fpcalc returned unexpected output: ${stdout.slice(0, 200)}`);
  }

  return { duration: Math.round(dur), fingerprint: fp };
}

/**
 * Looks up the fingerprint against the AcoustID web service and returns
 * deduplicated, score-filtered MusicMatch objects.
 */
async function lookupAcoustId(fp: FpcalcResult, apiKey: string): Promise<MusicMatch[]> {
  const params = new URLSearchParams({
    client: apiKey,
    duration: String(fp.duration),
    fingerprint: fp.fingerprint,
    meta: 'recordings+releasegroups+compress',
  });

  const response = await fetch(`${ACOUSTID_LOOKUP_URL}?${params}`, {
    signal: AbortSignal.timeout(ACOUSTID_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`AcoustID lookup returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as AcoustIdResponse;

  if (body.status !== 'ok' || !body.results?.length) {
    musicLog(`AcoustID: no results (status=${body.status})`);
    return [];
  }
  musicLog(`AcoustID: ${body.results.length} result(s), top score=${body.results[0]?.score?.toFixed(2)}`);

  const matches: MusicMatch[] = [];

  for (const result of body.results) {
    if (result.score < MIN_SCORE) continue;
    for (const rec of result.recordings ?? []) {
      const title = rec.title?.trim();
      const artist = rec.artists?.[0]?.name?.trim();
      if (!title || !artist) continue;

      const rg = rec.releasegroups?.[0];
      matches.push({
        source: 'fingerprint' as const,
        title,
        artist,
        album: rg?.title?.trim(),
        releaseDate: rg?.['first-release-date']?.trim(),
        mbid: rec.id,
        score: result.score,
      });
    }
  }

  // Deduplicate by mbid, keeping the highest-scored entry for each.
  const seen = new Map<string, MusicMatch>();
  for (const m of matches) {
    const key = m.mbid ?? `${m.artist}::${m.title}`;
    const existing = seen.get(key);
    if (!existing || m.score > existing.score) seen.set(key, m);
  }

  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/**
 * Merges two sets of music matches (e.g. existing stored matches + new chunk
 * matches, or fingerprint results + inferred results) into one deduplicated list.
 *
 * Dedup key: mbid when present, otherwise normalised `artist::title`.
 * Each song keeps the earliest `playOffsetMs` and the best `score`.
 * If a song exists in both sets, a `fingerprint` entry wins over `inferred`.
 * This is a pure function — it never throws and never mutates its arguments.
 */
export function mergeMusic(
  existing: MusicMatch[],
  incoming: MusicMatch[],
): MusicMatch[] {
  const seen = new Map<string, MusicMatch>();

  function dedupeKey(m: MusicMatch): string {
    return m.mbid ?? `${m.artist.toLowerCase()}::${m.title.toLowerCase()}`;
  }

  for (const m of [...existing, ...incoming]) {
    const key = dedupeKey(m);
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...m });
      continue;
    }
    // fingerprint always wins over inferred
    const winnerSource = prev.source === 'fingerprint' || m.source !== 'fingerprint'
      ? prev.source
      : 'fingerprint' as const;
    // earliest known offset
    const playOffsetMs =
      prev.playOffsetMs !== undefined && m.playOffsetMs !== undefined
        ? Math.min(prev.playOffsetMs, m.playOffsetMs)
        : prev.playOffsetMs ?? m.playOffsetMs;
    // best score
    const score = Math.max(prev.score, m.score);
    seen.set(key, { ...prev, source: winnerSource, playOffsetMs, score });
  }

  return [...seen.values()].sort((a, b) => {
    const aOff = a.playOffsetMs ?? Infinity;
    const bOff = b.playOffsetMs ?? Infinity;
    return aOff - bOff;
  });
}
