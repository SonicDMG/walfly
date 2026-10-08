/**
 * enrich.ts
 *
 * Turns a Docling ASR transcript into the structured fields the app displays:
 * title, summary, key takeaways, action items, tags and best-effort speakers.
 *
 * Two rules make this step trustworthy rather than decorative. An empty
 * transcript throws instead of being summarised, so a silent transcription
 * failure can never surface as a finished recording with a hallucinated
 * summary. And JSON mode is attempted but never required: proxies such as
 * Ollama reject `response_format`, so the call is retried without it and the
 * reply is parsed defensively from the raw text.
 */

import type { MusicDetection, MusicMatch } from '@walfly/db';
import { getLlmModel, getLlmProvider, getMusicDetectionModel, llmClient, supportsJsonMode } from './llm';

export interface EnrichResult {
  title: string;
  summary: string;
  keyTakeaways: string[];
  actionItems: string[];
  tags: string[];
  speakers: string[];
}

/** Well past a long walk; keeps the request inside every proxy's context window. */
const MAX_ENRICH_CHARS = 48_000;

const SYSTEM_PROMPT = `You are an expert analyst of spoken-word recordings. You are given a transcript produced by automatic speech recognition; lines may carry "[time: start-end]" prefixes, which you should ignore in your output.

Extract the following and respond with valid JSON only, matching this exact structure:
{
  "title": "string, a concise descriptive title, max 8 words",
  "summary": "string, 2-4 sentences describing what was said",
  "keyTakeaways": ["string", "3-7 key insights or conclusions"],
  "actionItems": ["string", "specific actions mentioned or implied; empty array if none"],
  "tags": ["string", "2-6 short lowercase topic tags"],
  "speakers": ["string", "names or labels of distinct speakers you can identify; empty array if unclear"]
}

Do not invent content that is not in the transcript. Do not wrap the JSON in prose or code fences.`;

const MUSIC_DETECTION_PROMPT = `You are an expert musicologist analyzing ASR transcripts for evidence of songs. The transcript may contain "[time: start-end]" prefixes — ignore them.

Your job is to identify songs whose lyrics, title, or artist appear in the transcript. Focus on these signals, strongest first:

1. LYRIC PATTERNS — lines that are clearly song lyrics rather than natural speech: poetic phrasing, repeated refrains, non-conversational imagery (e.g. "unfurl your gown", "let the sunrise come again", "beautiful girl"). If you recognise these as lyrics from a known song, name the song.
2. DIRECT MENTIONS — the speaker explicitly names a song or artist ("put on Strobe", "this is by INXS").
3. ANNOUNCEMENTS — a DJ, radio host, or speaker announces a track.

A line does NOT need to explicitly say "this is a song" for you to identify it. If you recognise the lyrics, that is sufficient evidence.

For each identified song return:
- title: the song title
- artist: the performing artist or band
- album: album name if you know it, otherwise null
- releaseDate: four-digit year if you know it, otherwise null
- score: your confidence (0.0–1.0)

Respond with valid JSON only:
{"detected": true, "matches": [{"title": "...", "artist": "...", "album": null, "releaseDate": null, "score": 0.8}]}
If no songs are identifiable, respond with: {"detected": false, "matches": []}

Do not wrap the JSON in prose or code fences. Do not hallucinate songs with no lyric or mention evidence in the transcript.`;

export async function enrichTranscript(transcript: string): Promise<EnrichResult> {
  const spoken = stripTimestamps(transcript);
  if (!spoken) {
    throw new Error(
      'Refusing to enrich an empty transcript — the transcription step produced no speech content.',
    );
  }

  const truncated =
    spoken.length > MAX_ENRICH_CHARS
      ? `${spoken.slice(0, MAX_ENRICH_CHARS)}\n\n[transcript truncated]`
      : spoken;

  const wasTruncated = spoken.length > MAX_ENRICH_CHARS;
  console.log(`[LLM:${getLlmProvider()}] starting enrichment — input=${truncated.length} chars${wasTruncated ? ' (truncated)' : ''}`);

  const raw = await completeJson(truncated);
  console.log(`[LLM:${getLlmProvider()}] response received (${raw.length} chars)`);
  const parsed = parseJsonObject(raw);

  const result = {
    title: clampString(asString(parsed.title) ?? '', 300) || 'Untitled recording',
    summary: asString(parsed.summary) ?? '',
    keyTakeaways: asStringArray(parsed.keyTakeaways),
    actionItems: asStringArray(parsed.actionItems),
    tags: asStringArray(parsed.tags).map((t) => t.toLowerCase()),
    speakers: asStringArray(parsed.speakers),
  };
  console.log(`[LLM:${getLlmProvider()}] parsed — title="${result.title}" takeaways=${result.keyTakeaways.length} actions=${result.actionItems.length} tags=[${result.tags.join(', ')}]`);
  return result;
}

/**
 * Runs the completion, attempting JSON mode first and retrying once without it
 * when the provider rejects `response_format`.
 */
async function completeJson(transcript: string, systemPrompt: string = SYSTEM_PROMPT): Promise<string> {
  return completeJsonWithModel(transcript, systemPrompt, getLlmModel());
}

async function completeJsonWithModel(transcript: string, systemPrompt: string, model: string): Promise<string> {
  const client = llmClient();

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: `Transcript:\n\n${transcript}` },
  ];

  if (supportsJsonMode()) {
    console.log(`[LLM:${getLlmProvider()}] → ${model} with JSON mode`);
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
      });
      return requireContent(response.choices[0]?.message?.content);
    } catch (err) {
      if (!isResponseFormatRejection(err)) throw err;
      console.warn(`[LLM:${getLlmProvider()}] provider rejected response_format — retrying without JSON mode`);
    }
  }

  console.log(`[LLM:${getLlmProvider()}] → ${model} without JSON mode`);
  const response = await client.chat.completions.create({
    model,
    messages,
  });
  return requireContent(response.choices[0]?.message?.content);
}

function requireContent(content: string | null | undefined): string {
  if (!content || !content.trim()) throw new Error('LLM returned an empty response during enrichment');
  return content;
}

/** A 400 that names response_format means the proxy does not implement JSON mode. */
function isResponseFormatRejection(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== 400) return false;
  const message = err instanceof Error ? err.message : String(err);
  return /response_format|json_object|json mode/i.test(message);
}

/**
 * Strips code fences and takes the outermost balanced object, because models
 * routinely answer with prose or ```json wrappers even in JSON mode.
 */
function parseJsonObject(raw: string): Record<string, unknown> {
  const withoutFences = raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const candidate = outermostObject(withoutFences) ?? withoutFences;

  try {
    const parsed = JSON.parse(candidate) as unknown;
    // Some models wrap the response in an array: [{...}] → unwrap element 0.
    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return first as Record<string, unknown>;
      }
      throw new Error('not a JSON object');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `LLM enrichment returned unparseable JSON (${err instanceof Error ? err.message : String(err)}): ${raw.slice(0, 500)}`,
    );
  }
}

/** Scans for the first `{` and its matching `}`, ignoring braces inside strings. */
function outermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** Removes Docling's "[time: a-b]" segment prefixes so emptiness is detectable. */
function stripTimestamps(transcript: string): string {
  return transcript
    .replace(/\[time:[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// ── LLM-based music detection (transcript analysis) ──────────────────────────

/**
 * Analyzes the ASR transcript for evidence of music — lyrics that were sung or
 * recited, humming/whistling of a recognizable melody, or a recognizable song
 * playing in the background. Complements the audio-fingerprint path
 * (detectMusic / detectMusicFromChunks): fingerprinting requires clean audio of
 * sufficient duration, but the LLM can infer music from lyrics that ASR captured
 * even when the audio fingerprint fails (short chunks, ambient mic quality).
 *
 * Never throws — returns { detected: false } on any failure so the enrichment
 * step is never blocked. The caller decides precedence: if audio fingerprinting
 * produced a result with specific MBIDs it wins; otherwise this LLM result is used.
 */
export async function detectMusicFromTranscript(transcript: string): Promise<MusicDetection> {
  const spoken = stripTimestamps(transcript);
  if (!spoken) {
    return { detected: false, matches: [], scannedAt: new Date().toISOString() };
  }

  const truncated =
    spoken.length > MAX_ENRICH_CHARS
      ? `${spoken.slice(0, MAX_ENRICH_CHARS)}\n\n[transcript truncated]`
      : spoken;

  const musicModel = getMusicDetectionModel();
  console.log(`[LLM:${getLlmProvider()}] starting music detection from transcript — model=${musicModel} input=${truncated.length} chars`);

  let raw: string;
  try {
    raw = await completeJsonWithModel(truncated, MUSIC_DETECTION_PROMPT, musicModel);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[LLM:${getLlmProvider()}] music detection from transcript failed (non-fatal): ${message}`);
    return { detected: false, matches: [], scannedAt: new Date().toISOString() };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(raw);
  } catch (err) {
    console.warn(`[LLM:${getLlmProvider()}] music detection returned unparseable JSON (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { detected: false, matches: [], scannedAt: new Date().toISOString() };
  }

  const detected = parsed.detected === true;
  const matches: MusicMatch[] = [];

  if (detected && Array.isArray(parsed.matches)) {
    for (const m of parsed.matches) {
      if (!m || typeof m !== 'object') continue;
      const title = asString((m as any).title);
      const artist = asString((m as any).artist);
      if (!title || !artist) continue;

      // Cap inferred score below fingerprint scores so merge rules treat it as weaker.
      const rawScore = typeof (m as any).score === 'number' ? (m as any).score : 0.5;
      matches.push({
        source: 'inferred' as const,
        title,
        artist,
        album: asString((m as any).album) ?? undefined,
        releaseDate: asString((m as any).releaseDate) ?? undefined,
        score: Math.min(rawScore, 0.6),
      });
    }
  }

  if (detected && matches.length > 0) {
    console.log(`[LLM:${getLlmProvider()}] 🎵 music detected in transcript — ${matches.length} match(es)`);
    for (const m of matches) {
      console.log(`[LLM:${getLlmProvider()}]   ♪ "${m.title}" by ${m.artist} [score: ${(m.score * 100).toFixed(0)}%]`);
    }
  } else {
    console.log(`[LLM:${getLlmProvider()}] no music detected in transcript`);
  }

  return {
    detected: detected && matches.length > 0,
    matches,
    scannedAt: new Date().toISOString(),
  };
}

