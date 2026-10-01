/**
 * collections.ts
 *
 * Typed accessor for the `recordings` and `recording_chunks` collections.
 * The collection names live in constants.ts so the seeder and the capability probe
 * can never drift from the collections the app actually reads.
 */

import type { Collection } from '@datastax/astra-db-ts';
import { getDb } from './client';
import {
  RECORDINGS_COLLECTION,
  RECORDING_CHUNKS_COLLECTION,
  VECTOR_DIMENSION,
  VECTOR_MODEL,
  CHUNKS_INDEXING_DENY,
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
