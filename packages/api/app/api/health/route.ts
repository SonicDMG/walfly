/**
 * GET /api/health
 *
 * One request that answers "why does nothing work?". It reports whether Astra
 * is reachable, whether the Docling and LLM credentials are present, which
 * audio storage backend is active, and whether this collection actually has the
 * region-limited hybrid-search features — so a missing env var or a
 * non-us-east-2 database is visible immediately instead of surfacing later as
 * an opaque pipeline failure.
 */

import { NextResponse } from 'next/server';
import { getCollectionCapabilities, getDb } from '@walfly/db';
import { isDoclingConfigured } from '@/lib/docling';
import { isLlmConfigured } from '@/lib/llm';
import { storageMode } from '@/lib/storage';

export const runtime = 'nodejs';

interface HealthResponse {
  status: 'ok' | 'degraded';
  service: 'walfly-api';
  checks: {
    astra: 'ok' | 'error';
    collection: 'ok' | 'missing' | 'unknown';
    docling: 'configured' | 'missing';
    llm: 'configured' | 'missing';
    storage: 'blob' | 'local';
  };
  hybridSearch: boolean;
  detail: string | null;
}

export async function GET() {
  let astra: 'ok' | 'error' = 'ok';
  let detail: string | null = null;

  try {
    await getDb().listCollections({ nameOnly: true });
  } catch (err) {
    astra = 'error';
    detail = err instanceof Error ? err.message : String(err);
  }

  const capabilities = await getCollectionCapabilities();

  // A reachable database with no `recordings` collection is the "why does
  // nothing work" case this route exists for: every upload 500s with
  // COLLECTION_NOT_EXIST, so it must never report a clean bill of health.
  const collection: 'ok' | 'missing' | 'unknown' = !capabilities.known
    ? 'unknown'
    : capabilities.exists
      ? 'ok'
      : 'missing';

  if (collection === 'missing') {
    detail =
      detail ??
      "The 'recordings' collection does not exist — run: npm run seed --workspace=packages/db";
  } else if (collection === 'unknown' && astra === 'ok') {
    detail = detail ?? 'Could not read the collection definition; hybrid-search support is unknown.';
  }

  const docling = isDoclingConfigured() ? 'configured' : 'missing';
  const llm = isLlmConfigured() ? 'configured' : 'missing';

  const storage = storageMode();
  if (storage === 'local' && process.env.VERCEL) {
    // Uploads hard-error in this combination; surface it before a user hits it.
    detail =
      detail ??
      'BLOB_READ_WRITE_TOKEN is required when deployed to Vercel (the filesystem is read-only and per-instance).';
  }

  const body: HealthResponse = {
    status:
      astra === 'ok' &&
      collection === 'ok' &&
      docling === 'configured' &&
      llm === 'configured' &&
      detail === null
        ? 'ok'
        : 'degraded',
    service: 'walfly-api',
    checks: { astra, collection, docling, llm, storage },
    hybridSearch: capabilities.lexical && capabilities.rerank,
    detail,
  };

  return NextResponse.json(body);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}
