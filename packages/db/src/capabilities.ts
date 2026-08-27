/**
 * capabilities.ts
 *
 * Runtime feature detection for the recordings collection. Lexical search and
 * reranking are region-limited public-preview features, so every read and write
 * path asks here first and falls back to a portable vector + token strategy.
 *
 * Only a SUCCESSFUL probe is memoised. Caching a failed probe would pin hybrid
 * search off for the whole process after a single Astra blip, and — because the
 * write path gates the `$lexical` field on this answer — would silently produce
 * documents that can never be found by the BM25 half of a hybrid query. A
 * failed probe therefore clears the cache, logs, and reports `known: false` so
 * callers can tell "the collection has no lexical index" apart from "we could
 * not find out".
 */

import { getDb } from './client';
import { RECORDINGS_COLLECTION } from './constants';

export interface CollectionCapabilities {
  lexical: boolean;
  rerank: boolean;
  exists: boolean;
  /** False when the probe itself failed, so every other field is a guess. */
  known: boolean;
}

const UNKNOWN: CollectionCapabilities = { lexical: false, rerank: false, exists: false, known: false };

let cached: Promise<CollectionCapabilities> | null = null;

export function getCollectionCapabilities(): Promise<CollectionCapabilities> {
  if (cached) return cached;

  // The `.then` runs in a microtask, so `probe` is always assigned by the time
  // the cache is evicted — and only an UNSUCCESSFUL probe is ever evicted.
  const probe: Promise<CollectionCapabilities> = probeCapabilities().then((capabilities) => {
    if (!capabilities.known && cached === probe) cached = null;
    return capabilities;
  });

  cached = probe;
  return probe;
}

async function probeCapabilities(): Promise<CollectionCapabilities> {
  try {
    const list = await getDb().listCollections();
    const descriptor = list.find((c) => c.name === RECORDINGS_COLLECTION);
    const definition = (descriptor?.definition ?? {}) as {
      lexical?: { enabled?: boolean };
      rerank?: { enabled?: boolean };
    };
    return {
      exists: Boolean(descriptor),
      lexical: definition.lexical?.enabled === true,
      rerank: definition.rerank?.enabled === true,
      known: true,
    };
  } catch (err) {
    console.warn(
      '[capabilities] Could not probe the recordings collection; assuming no hybrid search for this call:',
      err instanceof Error ? err.message : err,
    );
    return UNKNOWN;
  }
}

/** Test/ops hook: forces the next call to re-probe. */
export function resetCollectionCapabilities(): void {
  cached = null;
}
