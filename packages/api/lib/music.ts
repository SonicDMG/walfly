/**
 * music.ts
 *
 * Music detection via multimodal LLM audio analysis.
 *
 * Each live-session chunk is sent as raw audio to a multimodal model
 * (configured via MUSIC_DETECTION_MODEL, defaults to LLM_MODEL) which
 * both detects whether music is playing and attempts to identify the song
 * and artist. This works on ambient mic recordings without requiring any
 * local binaries (fpcalc, ffmpeg) or external fingerprint databases.
 *
 * Never throws — returns { detected: false } on any failure so the chunk
 * route and pipeline are never blocked by music detection.
 */

import type { ChatCompletion } from 'openai/resources/chat/completions';
import type { MusicDetection, MusicMatch } from '@walfly/db';
import { getMusicDetectionModel, llmClient } from './llm';

// ANSI colour helpers
const CYAN    = '\x1b[36m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const BOLD    = '\x1b[1m';
const RESET   = '\x1b[0m';

function musicLog(msg: string)  { console.log(`${CYAN}[music]${RESET} ${msg}`); }
function musicWarn(msg: string) { console.warn(`${YELLOW}[music]${RESET} ${msg}`); }

function notDetected(): MusicDetection {
  return { detected: false, matches: [], scannedAt: new Date().toISOString() };
}

const MUSIC_AUDIO_PROMPT = `Listen to this audio carefully. Your job is to detect whether music (a song) is playing — in the foreground or background — and if so identify it.

Respond with valid JSON only:
{"detected": true, "matches": [{"title": "...", "artist": "...", "album": null, "releaseDate": null, "score": 0.8}]}
If no music is playing, or if you are not highly certain of the identification, respond with: {"detected": false, "matches": []}

Rules:
- "detected" is true only if an actual song is playing (not just speech, ambient noise, or silence)
- A wrong identification is worse than no identification — only return a match if you are highly certain of the song title
- If you can hear music but cannot confidently identify it, return {"detected": false, "matches": []}
- "score" is your confidence in the identification (0.0–1.0); do not return a match with score below 0.85
- "album" and "releaseDate" are null unless you are confident
- Do not wrap JSON in prose or code fences`;

/**
 * Detects music in a raw audio chunk by sending it directly to a multimodal
 * LLM. Works on ambient mic recordings without any local binaries.
 * Never throws — returns { detected: false } on any failure.
 */
export async function detectMusicFromAudio(
  bytes: Uint8Array,
  filename: string,
  offsetMs: number,
): Promise<MusicDetection> {
  const model = getMusicDetectionModel();
  const client = llmClient();

  const ext = filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '.webm';

  try {
    // Determine MIME type for logging
    const mimeMap: Record<string, string> = {
      '.webm': 'audio/webm',
      '.mp4':  'audio/mp4',
      '.m4a':  'audio/mp4',
      '.ogg':  'audio/ogg',
      '.wav':  'audio/wav',
      '.mp3':  'audio/mpeg',
    };
    const mime = mimeMap[ext.toLowerCase()] ?? 'audio/webm';
    const b64 = Buffer.from(bytes).toString('base64');

    musicLog(`analysing chunk via ${model} (${(bytes.byteLength / 1024).toFixed(0)} KB, mime=${mime})`);

    // The `input_audio` content type is a multimodal extension not yet in the
    // OpenAI SDK type definitions, so we bypass the overload resolution.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.chat.completions.create as (req: unknown) => Promise<ChatCompletion>)({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: b64, format: ext.replace('.', '') } },
          { type: 'text', text: MUSIC_AUDIO_PROMPT },
        ],
      }],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    if (!raw) return notDetected();

    // Strip code fences if the model wraps anyway
    const clean = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      musicWarn(`unparseable JSON from audio detection (non-fatal): ${raw.slice(0, 120)}`);
      return notDetected();
    }

    if (!parsed.detected || !Array.isArray(parsed.matches) || parsed.matches.length === 0) {
      musicLog('no music detected in chunk');
      return notDetected();
    }

    const MIN_SCORE = 0.85;
    const matches: MusicMatch[] = [];
    for (const m of parsed.matches as Record<string, unknown>[]) {
      const title = typeof m.title === 'string' && m.title.trim() ? m.title.trim() : null;
      const artist = typeof m.artist === 'string' && m.artist.trim() ? m.artist.trim() : null;
      const score = typeof m.score === 'number' ? m.score : 0;
      if (!title) continue;
      if (score < MIN_SCORE) {
        musicLog(`skipping low-confidence match "${title}" (score ${(score * 100).toFixed(0)}% < ${MIN_SCORE * 100}%)`);
        continue;
      }
      matches.push({
        source: 'audio',
        title,
        artist: artist ?? 'Unknown',
        album: typeof m.album === 'string' ? m.album : undefined,
        releaseDate: typeof m.releaseDate === 'string' ? m.releaseDate : undefined,
        score,
        playOffsetMs: offsetMs,
      });
    }

    if (matches.length > 0) {
      console.log(`${BOLD}${GREEN}🎵 MUSIC DETECTED!${RESET}`);
      for (const m of matches) {
        console.log(`${BOLD}${MAGENTA}  ♪ "${m.title}" by ${m.artist} [score: ${(m.score * 100).toFixed(0)}%]${RESET}`);
      }
      return { detected: true, matches, scannedAt: new Date().toISOString() };
    }

    musicLog('no identifiable music in chunk');
    return notDetected();
  } catch (err) {
    musicWarn(`audio detection failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return notDetected();
  }
}

/**
 * Merges two sets of music matches into one deduplicated list.
 *
 * Dedup strategy (two-pass):
 *   1. Primary key: normalised artist::title — catches identical results.
 *   2. Title-only fallback: if an existing entry's artist is "unknown" and an
 *      incoming entry has the same title with a real artist name (or vice versa),
 *      they are treated as the same song and merged. This prevents the same song
 *      being stored multiple times when early windows can't identify the artist
 *      but a later window can.
 *
 * Merge rules: audio source beats inferred; earliest playOffsetMs wins; best
 * score wins; a real artist name beats "unknown".
 */
export function mergeMusic(existing: MusicMatch[], incoming: MusicMatch[]): MusicMatch[] {
  const seen = new Map<string, MusicMatch>();

  function normalise(s: string): string {
    return s.toLowerCase().trim();
  }

  function isUnknown(artist: string): boolean {
    return normalise(artist) === 'unknown';
  }

  function primaryKey(m: MusicMatch): string {
    return `${normalise(m.artist)}::${normalise(m.title)}`;
  }

  function titleKey(m: MusicMatch): string {
    return normalise(m.title);
  }

  function merge(prev: MusicMatch, next: MusicMatch): MusicMatch {
    const winnerSource: MusicMatch['source'] =
      (prev.source === 'audio' || next.source !== 'audio') ? prev.source : 'audio';
    const playOffsetMs =
      prev.playOffsetMs !== undefined && next.playOffsetMs !== undefined
        ? Math.min(prev.playOffsetMs, next.playOffsetMs)
        : prev.playOffsetMs ?? next.playOffsetMs;
    // Prefer a real artist name over "unknown"
    const artist = isUnknown(prev.artist) && !isUnknown(next.artist) ? next.artist : prev.artist;
    return { ...prev, artist, source: winnerSource, playOffsetMs, score: Math.max(prev.score, next.score) };
  }

  for (const m of [...existing, ...incoming]) {
    const pk = primaryKey(m);

    // Pass 1: exact artist::title match
    if (seen.has(pk)) {
      seen.set(pk, merge(seen.get(pk)!, m));
      continue;
    }

    // Pass 2: title-only fallback when one side has an unknown artist
    if (isUnknown(m.artist)) {
      const tk = titleKey(m);
      const titleMatch = [...seen.values()].find(s => normalise(s.title) === tk);
      if (titleMatch) {
        // Merge into the existing named-artist entry; don't add a second key
        const existingKey = primaryKey(titleMatch);
        seen.set(existingKey, merge(titleMatch, m));
        continue;
      }
    } else {
      // Incoming has a real artist — check if there is an "unknown" entry for this title
      const tk = titleKey(m);
      const unknownEntry = [...seen.values()].find(
        s => normalise(s.title) === tk && isUnknown(s.artist),
      );
      if (unknownEntry) {
        // Remove the unknown-artist key and re-insert under the real artist key
        seen.delete(primaryKey(unknownEntry));
        seen.set(pk, merge(unknownEntry, m));
        continue;
      }
    }

    seen.set(pk, { ...m });
  }

  return [...seen.values()].sort((a, b) => (a.playOffsetMs ?? Infinity) - (b.playOffsetMs ?? Infinity));
}
