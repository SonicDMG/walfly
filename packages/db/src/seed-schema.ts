/**
 * seed-schema.ts
 *
 * Creates the `recordings` collection with the exact definition the app needs:
 * NVIDIA vectorize, an indexing deny-list for the long free-text fields (any
 * indexed string over 8,000 bytes fails the whole write), and — where the
 * region supports it — lexical + rerank for hybrid search.
 *
 * Astra collection settings are immutable, so a collection created with the
 * wrong definition can only be fixed by dropping it. This script refuses to
 * pretend otherwise: it prints the drift and exits non-zero unless --recreate
 * is passed.
 *
 *   npm run seed --workspace=packages/db
 *   npm run seed --workspace=packages/db -- --recreate
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../api/.env.local') });

// eslint-disable-next-line @typescript-eslint/no-var-requires -- env must load before the client module reads it
const { getDb } = require('./client') as typeof import('./client');
const {
  RECORDINGS_COLLECTION, VECTOR_DIMENSION, VECTOR_MODEL, RERANK_MODEL, INDEXING_DENY,
} = require('./constants') as typeof import('./constants');

const RECREATE = process.argv.includes('--recreate');

const BASE_DEFINITION = {
  vector: {
    dimension: VECTOR_DIMENSION,
    metric: 'cosine' as const,
    service: { provider: 'nvidia', modelName: VECTOR_MODEL },
  },
  indexing: { deny: [...INDEXING_DENY] },
  // No defaultId: the server then generates STRING uuids, matching Recording._id.
};

const HYBRID_DEFINITION = {
  ...BASE_DEFINITION,
  lexical: { enabled: true, analyzer: 'standard' },
  rerank: { enabled: true, service: { provider: 'nvidia', modelName: RERANK_MODEL } },
};

async function main(): Promise<void> {
  const db = getDb();
  const existing = await db.listCollections();
  const found = existing.find((c) => c.name === RECORDINGS_COLLECTION);

  if (found && !RECREATE) {
    const definition = found.definition as Record<string, any>;
    const problems: string[] = [];
    const deny: string[] = definition?.indexing?.deny ?? [];
    for (const field of INDEXING_DENY) {
      if (!deny.includes(field)) problems.push(`indexing.deny is missing "${field}"`);
    }
    if (definition?.defaultId) problems.push('defaultId is set (it must be absent so _id stays a string)');
    if (definition?.vector?.service?.modelName !== VECTOR_MODEL) {
      problems.push(`vector.service.modelName is ${definition?.vector?.service?.modelName} (expected ${VECTOR_MODEL})`);
    }

    if (problems.length) {
      console.error(`[seed] Collection "${RECORDINGS_COLLECTION}" exists with a definition this app cannot use:`);
      for (const p of problems) console.error(`[seed]   - ${p}`);
      console.error('[seed] Astra collection settings are immutable. Re-run with -- --recreate to drop and rebuild.');
      process.exit(1);
    }

    console.log(`[seed] Collection "${RECORDINGS_COLLECTION}" already matches the expected definition.`);
    console.log(`[seed]   lexical=${definition?.lexical?.enabled === true} rerank=${definition?.rerank?.enabled === true}`);
    return;
  }

  if (found && RECREATE) {
    console.warn(`[seed] --recreate: dropping "${RECORDINGS_COLLECTION}" and ALL its documents.`);
    await db.dropCollection(RECORDINGS_COLLECTION);
  }

  try {
    await db.createCollection(RECORDINGS_COLLECTION, HYBRID_DEFINITION as any);
    console.log('[seed] Created with lexical + rerank (hybrid search available).');
  } catch (err) {
    console.warn('[seed] Hybrid options rejected by this database (region-limited preview). Retrying without them.');
    console.warn(`[seed]   reason: ${err instanceof Error ? err.message : String(err)}`);
    await db.createCollection(RECORDINGS_COLLECTION, BASE_DEFINITION as any);
    console.log('[seed] Created without lexical/rerank. Search falls back to vector + searchTokens.');
  }
}

main().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
