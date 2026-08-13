import { DataAPIClient } from '@datastax/astra-db-ts';

let _client: ReturnType<typeof DataAPIClient.prototype.db> | null = null;

/**
 * Returns a singleton Astra DB database handle.
 * Reads ASTRA_DB_API_ENDPOINT and ASTRA_DB_APPLICATION_TOKEN from env.
 */
export function getDb() {
  if (_client) return _client;

  const endpoint = process.env.ASTRA_DB_API_ENDPOINT;
  const token = process.env.ASTRA_DB_APPLICATION_TOKEN;

  if (!endpoint || !token) {
    throw new Error(
      'Missing ASTRA_DB_API_ENDPOINT or ASTRA_DB_APPLICATION_TOKEN env vars'
    );
  }

  const client = new DataAPIClient(token);
  _client = client.db(endpoint);
  return _client;
}
