/**
 * seed-schema.ts
 *
 * Idempotently creates the `recordings` collection in Astra DB with:
 *   - UUID default IDs
 *   - Built-in vectorize (nvidia/nv-embedqa-e5-v5 via Astra's integrated embedding)
 *
 * Run with:
 *   npm run seed --workspace=packages/db
 *
 * Requires ASTRA_DB_API_ENDPOINT and ASTRA_DB_APPLICATION_TOKEN in env.
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load from packages/api/.env.local (where Astra credentials live)
config({ path: resolve(__dirname, '../../api/.env.local') });
import { getDb } from './client';

const COLLECTION_NAME = 'recordings';

async function seed() {
  console.log('[seed] Starting...');
  console.log(`[seed] ASTRA_DB_API_ENDPOINT : ${process.env.ASTRA_DB_API_ENDPOINT ?? '(not set)'}`);
  console.log(`[seed] ASTRA_DB_APPLICATION_TOKEN : ${process.env.ASTRA_DB_APPLICATION_TOKEN ? '(set)' : '(not set)'}`);

  const db = getDb();
  console.log('[seed] DB client initialised');

  console.log('[seed] Listing existing collections...');
  const existing = await db.listCollections();
  const names = existing.map((c) => c.name);
  console.log(`[seed] Found collections: ${names.length ? names.join(', ') : '(none)'}`);

  if (names.includes(COLLECTION_NAME)) {
    console.log(`[seed] Collection "${COLLECTION_NAME}" already exists — skipping creation.`);
    return;
  }

  const options = {
    defaultId: { type: 'uuid' as const },
    vector: {
      metric: 'cosine' as const,
      service: {
        provider: 'nvidia',
        modelName: 'nvidia/nv-embedqa-e5-v5',
      },
    },
  };
  console.log(`[seed] Creating collection "${COLLECTION_NAME}" with options:`);
  console.log(JSON.stringify(options, null, 2));

  await db.createCollection(COLLECTION_NAME, options);

  console.log(`[seed] Collection "${COLLECTION_NAME}" created successfully.`);
  console.log(`[seed]   metric    : cosine`);
  console.log(`[seed]   vectorize : nvidia/nv-embedqa-e5-v5`);
}

seed().catch((err) => {
  console.error('[seed] Failed:', err);
  process.exit(1);
});
