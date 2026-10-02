/**
 * seed-schema-v2.ts
 *
 * Creates the v2 collections:
 *   - recordings_v2: hybrid vector+lexical+rerank (same as v1), no `chunks` array,
 *     deny-list extended with `chunks` as belt-and-suspenders.
 *   - recording_chunks_v2: NO vector index — pure write-ahead log. Only
 *     `transcript` and `audioUrl` are denied from indexing.
 *
 * V1 collections are left untouched.
 *
 *   npm run seed:v2 --workspace=packages/db
 *   npm run seed:v2 --workspace=packages/db -- --recreate
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../api/.env.local') });

// eslint-disable-next-line @typescript-eslint/no-var-requires -- env must load before the client module reads it
const { getDb } = require('./client') as typeof import('./client');
const {
  RECORDINGS_V2_COLLECTION,
  RECORDING_CHUNKS_V2_COLLECTION,
  VECTOR_DIMENSION,
  VECTOR_MODEL,
  RERANK_MODEL,
  INDEXING_DENY_V2,
  CHUNKS_INDEXING_DENY_V2,
} = require('./constants') as typeof import('./constants');

const RECREATE = process.argv.includes('--recreate');

const BASE_DEFINITION = {
  vector: {
    dimension: VECTOR_DIMENSION,
    metric: 'cosine' as const,
    service: { provider: 'nvidia', modelName: VECTOR_MODEL },
  },
  indexing: { deny: [...INDEXING_DENY_V2] },
};

const HYBRID_DEFINITION = {
  ...BASE_DEFINITION,
  lexical: { enabled: true, analyzer: 'standard' },
  rerank: { enabled: true, service: { provider: 'nvidia', modelName: RERANK_MODEL } },
};

async function main(): Promise<void> {
  const db = getDb();
  const existing = await db.listCollections();

  // ── recordings_v2 ─────────────────────────────────────────────────────────
  const foundV2 = existing.find((c) => c.name === RECORDINGS_V2_COLLECTION);

  if (foundV2 && !RECREATE) {
    const definition = foundV2.definition as Record<string, any>;
    const problems: string[] = [];
    const deny: string[] = definition?.indexing?.deny ?? [];
    for (const field of INDEXING_DENY_V2) {
      if (!deny.includes(field)) problems.push(`indexing.deny is missing "${field}"`);
    }
    if (definition?.defaultId) problems.push('defaultId is set (it must be absent so _id stays a string)');
    if (definition?.vector?.service?.modelName !== VECTOR_MODEL) {
      problems.push(`vector.service.modelName is ${definition?.vector?.service?.modelName} (expected ${VECTOR_MODEL})`);
    }

    if (problems.length) {
      console.error(`[seed:v2] Collection "${RECORDINGS_V2_COLLECTION}" exists with a definition this app cannot use:`);
      for (const p of problems) console.error(`[seed:v2]   - ${p}`);
      console.error('[seed:v2] Astra collection settings are immutable. Re-run with -- --recreate to drop and rebuild.');
      process.exit(1);
    }

    console.log(`[seed:v2] Collection "${RECORDINGS_V2_COLLECTION}" already matches the expected definition.`);
    console.log(`[seed:v2]   lexical=${definition?.lexical?.enabled === true} rerank=${definition?.rerank?.enabled === true}`);
  } else {
    if (foundV2 && RECREATE) {
      console.warn(`[seed:v2] --recreate: dropping "${RECORDINGS_V2_COLLECTION}" and ALL its documents.`);
      await db.dropCollection(RECORDINGS_V2_COLLECTION);
    }

    try {
      await db.createCollection(RECORDINGS_V2_COLLECTION, HYBRID_DEFINITION as any);
      console.log(`[seed:v2] Created "${RECORDINGS_V2_COLLECTION}" with lexical + rerank (hybrid search available).`);
    } catch (err) {
      console.warn('[seed:v2] Hybrid options rejected by this database (region-limited preview). Retrying without them.');
      console.warn(`[seed:v2]   reason: ${err instanceof Error ? err.message : String(err)}`);
      await db.createCollection(RECORDINGS_V2_COLLECTION, BASE_DEFINITION as any);
      console.log(`[seed:v2] Created "${RECORDINGS_V2_COLLECTION}" without lexical/rerank. Search falls back to vector + searchTokens.`);
    }
  }

  // ── recording_chunks_v2 ───────────────────────────────────────────────────
  // No vector index — pure write-ahead log. Only deny transcript + audioUrl.
  const foundChunksV2 = existing.find((c) => c.name === RECORDING_CHUNKS_V2_COLLECTION);
  const CHUNKS_V2_DEFINITION = {
    indexing: { deny: [...CHUNKS_INDEXING_DENY_V2] },
  };

  if (foundChunksV2 && !RECREATE) {
    console.log(`[seed:v2] Collection "${RECORDING_CHUNKS_V2_COLLECTION}" already exists.`);
  } else {
    if (foundChunksV2 && RECREATE) {
      console.warn(`[seed:v2] --recreate: dropping "${RECORDING_CHUNKS_V2_COLLECTION}" and ALL its documents.`);
      await db.dropCollection(RECORDING_CHUNKS_V2_COLLECTION);
    }
    await db.createCollection(RECORDING_CHUNKS_V2_COLLECTION, CHUNKS_V2_DEFINITION as any);
    console.log(`[seed:v2] Created "${RECORDING_CHUNKS_V2_COLLECTION}" (no vector index — write-ahead log only).`);
  }
}

main().catch((err) => {
  console.error('[seed:v2] Failed:', err);
  process.exit(1);
});
