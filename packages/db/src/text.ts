/**
 * text.ts
 *
 * Bounded-text helpers shared by every Astra write. The embedding provider caps
 * input at 512 tokens and any indexed string is capped at 8,000 bytes, so these
 * are correctness requirements, not cosmetics.
 */

import { MAX_SEARCH_TOKENS, MAX_TAG_CHARS, MAX_TAGS, INDEXED_STRING_MAX_CHARS, VECTORIZE_MAX_CHARS } from './constants';

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

export function clampTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().slice(0, MAX_TAG_CHARS))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}
