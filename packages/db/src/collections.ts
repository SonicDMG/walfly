/**
 * collections.ts
 *
 * Typed accessors for all Astra DB collections.
 *
 * V1 collections (`recordings`, `recording_chunks`) are retained for posterity.
 * V2 collections (`recordings_v2`, `recording_chunks_v2`) implement the clean
 * two-collection design from GitHub issue #34:
 *   - recordings_v2: no `chunks` array; fully enriched document with $vectorize
 *     built from LLM summary — the complete, queryable recording.
 *   - recording_chunks_v2: one document per audio chunk; raw transcript stored
 *     but NOT indexed ($vectorize absent); pure resilient write-ahead log used
 *     for stitching during the live session.
 *
 * The collection names live in constants.ts so the seeder and the capability
 * probe can never drift from the collections the app actually reads.
 */

import type { Collection } from '@datastax/astra-db-ts';
import { getDb } from './client';
import {
  RECORDINGS_COLLECTION,
  RECORDING_CHUNKS_COLLECTION,
  RECORDINGS_V2_COLLECTION,
  RECORDING_CHUNKS_V2_COLLECTION,
  VECTOR_DIMENSION,
  VECTOR_MODEL,
  CHUNKS_INDEXING_DENY,
  CHUNKS_INDEXING_DENY_V2,
} from './constants';
import type { Recording, RecordingChunk } from './types';

export function getRecordingsCollection(): Collection<Recording> {
  return getDb().collection<Recording>(RECORDINGS_COLLECTION);
}

let chunksCollectionEnsured = false;
let chunksCollectionPromise: Promise<void> | null = null;

/**
 * Ensures the `recording_chunks` collection exists in Astra DB before accessing it,
 * preventing 500 errors if the DB was not seeded beforehand.
 */
export async function ensureRecordingChunksCollection(): Promise<Collection<RecordingChunk>> {
  const db = getDb();
  if (!chunksCollectionEnsured) {
    if (!chunksCollectionPromise) {
      chunksCollectionPromise = (async () => {
        try {
          const collections = await db.listCollections();
          if (!collections.some((c) => c.name === RECORDING_CHUNKS_COLLECTION)) {
            console.log(`[Astra] Lazy-creating "${RECORDING_CHUNKS_COLLECTION}" collection...`);
            await db.createCollection(RECORDING_CHUNKS_COLLECTION, {
              vector: {
                dimension: VECTOR_DIMENSION,
                metric: 'cosine',
                service: { provider: 'nvidia', modelName: VECTOR_MODEL },
              },
              indexing: { deny: [...CHUNKS_INDEXING_DENY] },
            } as any);
            console.log(`[Astra] "${RECORDING_CHUNKS_COLLECTION}" collection created.`);
          }
          chunksCollectionEnsured = true;
        } catch (err: any) {
          // If already exists or created concurrently, mark ensured
          if (err?.message?.includes('already exists') || err?.code === 'COLLECTION_ALREADY_EXISTS') {
            chunksCollectionEnsured = true;
          } else {
            console.warn(`[Astra] Notice while checking/creating ${RECORDING_CHUNKS_COLLECTION}:`, err);
          }
        } finally {
          chunksCollectionPromise = null;
        }
      })();
    }
    await chunksCollectionPromise;
  }
  return db.collection<RecordingChunk>(RECORDING_CHUNKS_COLLECTION);
}

export function getRecordingChunksCollection(): Collection<RecordingChunk> {
  return getDb().collection<RecordingChunk>(RECORDING_CHUNKS_COLLECTION);
}

// ─── V2 accessors ────────────────────────────────────────────────────────────

export function getRecordingsV2Collection(): Collection<Recording> {
  return getDb().collection<Recording>(RECORDINGS_V2_COLLECTION);
}

let chunksV2CollectionEnsured = false;
let chunksV2CollectionPromise: Promise<void> | null = null;

/**
 * Ensures the `recording_chunks_v2` collection exists before accessing it.
 * recording_chunks_v2 has NO vector index — it is a pure write-ahead log.
 * transcript is denied from indexing so raw ASR text never hits the 8KB limit.
 */
export async function ensureRecordingChunksV2Collection(): Promise<Collection<RecordingChunk>> {
  const db = getDb();
  if (!chunksV2CollectionEnsured) {
    if (!chunksV2CollectionPromise) {
      chunksV2CollectionPromise = (async () => {
        try {
          const collections = await db.listCollections();
          if (!collections.some((c) => c.name === RECORDING_CHUNKS_V2_COLLECTION)) {
            console.log(`[Astra] Lazy-creating "${RECORDING_CHUNKS_V2_COLLECTION}" collection...`);
            await db.createCollection(RECORDING_CHUNKS_V2_COLLECTION, {
              indexing: { deny: [...CHUNKS_INDEXING_DENY_V2] },
            } as any);
            console.log(`[Astra] "${RECORDING_CHUNKS_V2_COLLECTION}" collection created.`);
          }
          chunksV2CollectionEnsured = true;
        } catch (err: any) {
          if (err?.message?.includes('already exists') || err?.code === 'COLLECTION_ALREADY_EXISTS') {
            chunksV2CollectionEnsured = true;
          } else {
            console.warn(`[Astra] Notice while checking/creating ${RECORDING_CHUNKS_V2_COLLECTION}:`, err);
          }
        } finally {
          chunksV2CollectionPromise = null;
        }
      })();
    }
    await chunksV2CollectionPromise;
  }
  return db.collection<RecordingChunk>(RECORDING_CHUNKS_V2_COLLECTION);
}

export function getRecordingChunksV2Collection(): Collection<RecordingChunk> {
  return getDb().collection<RecordingChunk>(RECORDING_CHUNKS_V2_COLLECTION);
}
