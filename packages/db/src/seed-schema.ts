/**
 * seed-schema.ts
 *
 * Idempotently creates the `recordings` collection in Astra DB with:
 *   - UUID default IDs
 *   - Built-in vectorize (nvidia NV-Embed-QA via Astra's integrated embedding)
 *
 * Run with:
 *   npm run seed --workspace=packages/db
 *
 * Requires ASTRA_DB_API_ENDPOINT and ASTRA_DB_APPLICATION_TOKEN in env.
 */

import 'dotenv/config';
import { getDb } from './client';

const COLLECTION_NAME = 'recordings';

// Astra's integrated vectorize dimension for nvidia NV-Embed-QA is 1024.
// See: https://docs.datastax.com/en/astra-db-serverless/databases/embedding-generation.html
const VECTOR_DIMENSION = 1024;

async function seed() {
  const db = getDb();

  // List existing collections to check idempotency
  const existing = await db.listCollections();
  const names = existing.map((c) => c.name);

  if (names.includes(COLLECTION_NAME)) {
    console.log(`Collection "${COLLECTION_NAME}" already exists — skipping creation.`);
    return;
  }

  await db.createCollection(COLLECTION_NAME, {
    defaultId: { type: 'uuid' },
    vector: {
      dimension: VECTOR_DIMENSION,
      metric: 'cosine',
      service: {
        provider: 'nvidia',
        modelName: 'NV-Embed-QA',
      },
    },
  });

  console.log(`Collection "${COLLECTION_NAME}" created successfully.`);
  console.log(`  dimension : ${VECTOR_DIMENSION}`);
  console.log(`  metric    : cosine`);
  console.log(`  vectorize : nvidia/NV-Embed-QA`);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
