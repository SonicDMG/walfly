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

import { getLlmModel, llmClient, supportsJsonMode } from './llm';

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

  const raw = await completeJson(truncated);
  const parsed = parseJsonObject(raw);

  return {
    title: clampString(asString(parsed.title) ?? '', 300) || 'Untitled recording',
    summary: asString(parsed.summary) ?? '',
    keyTakeaways: asStringArray(parsed.keyTakeaways),
    actionItems: asStringArray(parsed.actionItems),
    tags: asStringArray(parsed.tags).map((t) => t.toLowerCase()),
    speakers: asStringArray(parsed.speakers),
  };
}

/**
 * Runs the completion, attempting JSON mode first and retrying once without it
 * when the provider rejects `response_format`.
 */
async function completeJson(transcript: string): Promise<string> {
  const client = llmClient();
  const model = getLlmModel();

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: `Transcript:\n\n${transcript}` },
  ];

  if (supportsJsonMode()) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
      });
      return requireContent(response.choices[0]?.message?.content);
    } catch (err) {
      if (!isResponseFormatRejection(err)) throw err;
      console.warn('[enrich] provider rejected response_format — retrying without JSON mode');
    }
  }

  const response = await client.chat.completions.create({
    model,
    messages,
    temperature: 0.3,
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
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
