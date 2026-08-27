/**
 * GET /api/recordings
 *
 * Lists recordings newest-first, or searches them when ?q= is present.
 *
 * Search has two paths because lexical/rerank are a region-limited Astra
 * preview. When the collection has them, one findAndRerank call does BM25 +
 * vector retrieval with an NVIDIA reranker. Everywhere else the portable path
 * fuses a vector search with a `searchTokens: {$in: ...}` keyword search using
 * Reciprocal Rank Fusion. `$regex`, `$options` and `$elemMatch` are NOT Astra
 * operators and are deliberately absent — sending them fails the whole command.
 *
 * Every response is projected: full transcripts for 100 documents would trip
 * the platform's 4.5 MB response cap.
 *
 * Query params:
 *   q       - optional search query
 *   limit   - optional max results (default 50, hard max 100)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  clampVectorizeText,
  getCollectionCapabilities,
  getRecordingsCollection,
  tokenizeQuery,
} from '@walfly/db';
import type { Recording, RecordingSummary } from '@walfly/db';

export const runtime = 'nodejs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const RETRIEVAL_LIMIT = 20;
/** Standard RRF damping constant; keeps a rank-1 hit from dominating outright. */
const RRF_K = 60;

const SUMMARY_PROJECTION = {
  _id: 1,
  title: 1,
  createdAt: 1,
  duration: 1,
  status: 1,
  tags: 1,
  summary: 1,
  location: 1,
  audioUrl: 1,
  audioContentType: 1,
  error: 1,
} as const;

/** Strips everything the list screen does not render, transcripts above all. */
function toSummary(doc: Recording): RecordingSummary {
  return {
    _id: doc._id,
    title: doc.title ?? 'Untitled recording',
    createdAt: doc.createdAt,
    duration: typeof doc.duration === 'number' ? doc.duration : 0,
    status: doc.status,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    summary: doc.summary ?? null,
    location: doc.location ?? null,
    audioUrl: doc.audioUrl,
    audioContentType: doc.audioContentType ?? 'application/octet-stream',
    error: doc.error ?? null,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q')?.trim() ?? '';

  const rawLimit = Number(searchParams.get('limit'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  try {
    // Inside the try: getRecordingsCollection() performs the env check, and an
    // uncaught throw here would be an empty-bodied 500 on the single most
    // common setup mistake.
    const collection = getRecordingsCollection();

    if (!q) {
      console.log(`[Astra] listing all recordings (limit=${limit})`);
      // In-memory sort on an indexed field: fine below ~10k documents.
      const docs = await collection
        .find({}, { sort: { createdAt: -1 }, limit, projection: SUMMARY_PROJECTION })
        .toArray();
      console.log(`[Astra] list returned ${docs.length} documents`);
      return NextResponse.json(docs.map((d) => toSummary(d as unknown as Recording)));
    }

    // The 512-token cap on nv-embedqa-e5-v5 applies to QUERY strings too: an
    // over-long sort value is rejected by the provider and fails the command.
    const vectorQuery = clampVectorizeText(q);

    console.log(`[Astra] search query="${q}" vectorQuery=${vectorQuery.length} chars`);
    const capabilities = await getCollectionCapabilities();
    console.log(`[Astra] capabilities: lexical=${capabilities.lexical} rerank=${capabilities.rerank} known=${capabilities.known}`);

    if (capabilities.lexical && capabilities.rerank) {
      // No projection here: the server reranks on $lexical, so the fields are
      // stripped in JS afterwards instead.
      console.log(`[Astra / Vectorize] using hybrid findAndRerank with NVIDIA reranker (vectorLimit=${RETRIEVAL_LIMIT} lexicalLimit=${RETRIEVAL_LIMIT})`);
      const rows = await collection
        .findAndRerank(
          { status: 'ready' },
          { sort: { $hybrid: vectorQuery }, hybridLimits: { $vector: RETRIEVAL_LIMIT, $lexical: RETRIEVAL_LIMIT }, limit },
        )
        .toArray();

      console.log(`[Astra / Vectorize] findAndRerank returned ${rows.length} results`);
      return NextResponse.json(rows.map((r) => toSummary(r.document as unknown as Recording)));
    }

    console.log(`[Astra / Vectorize] using portable RRF search (vector + token)`);
    return NextResponse.json(await portableSearch(collection, q, vectorQuery, limit));
  } catch (err) {
    logDataApiError('search', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list recordings' },
      { status: 500 },
    );
  }
}

/**
 * Vector search fused with a token search via Reciprocal Rank Fusion. Works in
 * every Astra region because it uses only universally supported operators.
 */
async function portableSearch(
  collection: ReturnType<typeof getRecordingsCollection>,
  q: string,
  vectorQuery: string,
  limit: number,
): Promise<RecordingSummary[]> {
  const tokens = tokenizeQuery(q);
  console.log(`[Astra / Vectorize] portableSearch tokens=[${tokens.join(', ')}] vectorLimit=${RETRIEVAL_LIMIT}`);

  const [vecR, kwR] = await Promise.allSettled([
    collection
      .find(
        { status: 'ready' },
        { sort: { $vectorize: vectorQuery }, limit: RETRIEVAL_LIMIT, includeSimilarity: true, projection: SUMMARY_PROJECTION },
      )
      .toArray(),
    tokens.length
      ? collection
          .find(
            // "contains any of these tokens", expressed with operators Astra
            // supports in every region. Each $all holds a single element, so
            // the clause reads as array-contains rather than array-equals.
            { status: 'ready', $or: tokens.map((token) => ({ searchTokens: { $all: [token] } })) },
            { limit: RETRIEVAL_LIMIT, projection: SUMMARY_PROJECTION },
          )
          .toArray()
      : Promise.resolve([]),
  ]);

  if (vecR.status === 'rejected') logDataApiError('vector search', vecR.reason);
  if (kwR.status === 'rejected') logDataApiError('token search', kwR.reason);

  if (vecR.status === 'rejected' && kwR.status === 'rejected') {
    throw vecR.reason;
  }

  const vectorHits = vecR.status === 'fulfilled' ? (vecR.value as unknown as Recording[]) : [];
  const keywordHits = kwR.status === 'fulfilled' ? (kwR.value as unknown as Recording[]) : [];
  console.log(`[Astra / Vectorize] portableSearch vector=${vectorHits.length} hits keyword=${keywordHits.length} hits`);

  const scored = new Map<string, { doc: Recording; score: number }>();

  const fuse = (docs: Recording[]) => {
    docs.forEach((doc, index) => {
      const existing = scored.get(doc._id);
      const contribution = 1 / (RRF_K + index + 1);
      if (existing) {
        existing.score += contribution;
      } else {
        scored.set(doc._id, { doc, score: contribution });
      }
    });
  };

  fuse(vectorHits);
  fuse(keywordHits);

  return Array.from(scored.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Deterministic tie-break so identical scores never reorder per request.
      return (b.doc.createdAt ?? '').localeCompare(a.doc.createdAt ?? '');
    })
    .slice(0, limit)
    .map(({ doc }) => toSummary(doc));
}

/** Surfaces the Data API's own error code, which names the real problem. */
function logDataApiError(phase: string, err: unknown): void {
  const descriptors = (err as { errorDescriptors?: Array<{ errorCode?: string; message?: string }> })
    ?.errorDescriptors;
  const code = descriptors?.[0]?.errorCode;
  console.error(
    `[recordings] ${phase} failed${code ? ` (${code})` : ''}:`,
    err instanceof Error ? err.message : err,
  );
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}
