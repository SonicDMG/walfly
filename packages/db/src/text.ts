/**
 * text.ts
 *
 * Bounded-text helpers shared by every Astra write. The embedding provider caps
 * input at 512 tokens and any indexed string is capped at 8,000 bytes, so these
 * are correctness requirements, not cosmetics.
 */

import {
  MAX_SEARCH_TOKENS,
  MAX_TAG_CHARS,
  MAX_TAGS,
  INDEXED_STRING_MAX_CHARS,
  VECTORIZE_MAX_CHARS,
  MAX_CHUNK_TRANSCRIPT_BYTES,
} from './constants';

const STOPWORDS = new Set(['the','a','an','and','or','of','to','in','is','it','for','on','with','that','this','was','at','as','be','are','i','you','we']);

/** Text sent to the embedding model. Never include the transcript. */
export function buildVectorizeText(parts: { title: string; summary: string | null; keyTakeaways: string[]; tags: string[] }): string {
  return [parts.title, parts.summary ?? '', ...parts.keyTakeaways, parts.tags.join(' ')]
    .filter(Boolean)
    .join('\n')
    .slice(0, VECTORIZE_MAX_CHARS);
}

/** Lowercased, deduped, stopword-stripped tokens for the `$in` keyword fallback. */
export function buildSearchTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || raw.length > 40 || STOPWORDS.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= MAX_SEARCH_TOKENS) break;
  }
  return [...seen];
}

/** Tokenises a user query the same way, capped at 12 terms. */
export function tokenizeQuery(q: string): string[] {
  return buildSearchTokens(q).slice(0, 12);
}

/**
 * Clamps any string handed to the embedding model. The 512-token cap applies to
 * QUERIES as well as writes: an over-long `$vectorize`/`$hybrid` sort string is
 * rejected by the provider and fails the whole Data API command.
 */
export function clampVectorizeText(value: string): string {
  return value.slice(0, VECTORIZE_MAX_CHARS);
}

export function clampIndexedString(value: string): string {
  return value.slice(0, INDEXED_STRING_MAX_CHARS);
}

/**
 * Clamps a string so its UTF-8 encoded representation does not exceed maxBytes.
 * Strips incomplete multi-byte code units and surrogate halves to guarantee <= maxBytes.
 */
export function clampUtf8Bytes(value: string, maxBytes: number = MAX_CHUNK_TRANSCRIPT_BYTES): string {
  if (!value) return '';
  const encoder = new TextEncoder();
  const encoded = encoder.encode(value);
  if (encoded.length <= maxBytes) return value;

  // Determine a safe cut point where we don't land in the middle of a UTF-8 sequence
  let cut = maxBytes;
  while (cut > 0 && (encoded[cut] & 0xc0) === 0x80) {
    cut--; // Step backwards over UTF-8 continuation bytes
  }
  // If the leading byte indicates a multibyte sequence that exceeds maxBytes, drop that leading byte
  if (cut > 0) {
    const byte = encoded[cut - 1];
    if ((byte & 0xe0) === 0xc0 && cut - 1 + 2 > maxBytes) cut -= 1;
    else if ((byte & 0xf0) === 0xe0 && cut - 1 + 3 > maxBytes) cut -= 1;
    else if ((byte & 0xf8) === 0xf0 && cut - 1 + 4 > maxBytes) cut -= 1;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let result = decoder.decode(encoded.subarray(0, cut));
  while (encoder.encode(result).length > maxBytes && result.length > 0) {
    result = result.slice(0, -1);
  }
  return result;
}

export interface SplitTranscriptOptions {
  maxBytes?: number;
  overlapBytes?: number;
}

/**
 * Splits arbitrary transcript text into chunks strictly <= maxBytes UTF-8.
 * Breaks at the latest natural delimiter (paragraph, sentence, line, word)
 * in the second half of the byte window to preserve readability and semantic coherence.
 */
export function splitTranscriptByBytes(
  text: string,
  options: SplitTranscriptOptions = {},
): string[] {
  if (!text) return [];

  const { maxBytes = MAX_CHUNK_TRANSCRIPT_BYTES, overlapBytes = 0 } = options;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const encoded = encoder.encode(text);

  if (encoded.length <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < encoded.length) {
    let end = Math.min(offset + maxBytes, encoded.length);

    if (end < encoded.length) {
      const candidateStr = decoder.decode(encoded.subarray(offset, end));

      const lastParagraph = candidateStr.lastIndexOf('\n\n');
      const lastSentence = Math.max(
        candidateStr.lastIndexOf('. '),
        candidateStr.lastIndexOf('? '),
        candidateStr.lastIndexOf('! '),
      );
      const lastLine = candidateStr.lastIndexOf('\n');
      const lastSpace = candidateStr.lastIndexOf(' ');

      const breakIdx = [
        lastParagraph,
        lastSentence !== -1 ? lastSentence + 1 : -1,
        lastLine,
        lastSpace,
      ]
        .filter((idx) => idx > candidateStr.length * 0.5)
        .sort((a, b) => b - a)[0];

      if (breakIdx !== undefined && breakIdx > 0) {
        const breakEncodedLen = encoder.encode(candidateStr.slice(0, breakIdx + 1)).length;
        end = offset + breakEncodedLen;
      }
    }

    const chunkBytes = encoded.subarray(offset, end);
    const chunkText = decoder.decode(chunkBytes).trim();
    if (chunkText.length > 0) {
      chunks.push(chunkText);
    }

    if (end >= encoded.length) break;

    offset = Math.max(offset + 1, end - overlapBytes);
  }

  return chunks;
}

export function clampTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().slice(0, MAX_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}
