/**
 * client.ts
 *
 * Singleton Astra DB handle with explicit timeouts, so a hung Data API call
 * fails fast instead of holding a serverless invocation open until the
 * platform kills it. Env is read lazily on first use, never at module scope.
 */

import { DataAPIClient, type Db } from '@datastax/astra-db-ts';

let db: Db | null = null;

export function getDb(): Db {
  if (db) return db;

  const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
  const token = process.env.ASTRA_DB_APPLICATION_TOKEN;
  if (!endpoint || !token) {
    throw new Error('Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN env vars');
  }

  const client = new DataAPIClient(token, {
    timeoutDefaults: { requestTimeoutMs: 20_000, generalMethodTimeoutMs: 45_000 },
  });

  db = client.db(endpoint, process.env.ASTRA_DB_KEYSPACE ? { keyspace: process.env.ASTRA_DB_KEYSPACE } : undefined);
  return db;
}
