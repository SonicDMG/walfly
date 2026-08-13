/**
 * GET /api/recordings
 *
 * Returns recordings sorted by date descending.
 * If ?q=<term> is provided, runs hybrid search:
 *   - Vector search: sort by $vectorize similarity to the query
 *   - Keyword search: filter on title, tags, notes, transcript containing the term
 * Results are merged, deduplicated by _id, and sorted by combined score.
 *
 * Query params:
 *   q       - optional search query string
 *   limit   - optional max results (default 50)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRecordingsCollection } from '@walfly/db';
import type { Recording } from '@walfly/db';

const DEFAULT_LIMIT = 50;
const VECTOR_LIMIT = 20;
const KEYWORD_LIMIT = 20;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q')?.trim() ?? '';
  const limit = Math.min(Number(searchParams.get('limit') ?? DEFAULT_LIMIT), 100);

  const collection = getRecordingsCollection();

  if (!q) {
    // No query — return all recordings sorted by date descending
    const cursor = collection.find({}, { sort: { createdAt: -1 }, limit });
    const results = await cursor.toArray();
    return NextResponse.json(results);
  }

  // Hybrid search: run vector + keyword in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    // Vector search — Astra auto-embeds the query via $vectorize
    collection
      .find({}, { sort: { $vectorize: q }, limit: VECTOR_LIMIT, includeSimilarity: true })
      .toArray(),

    // Keyword search — case-insensitive regex across text fields
    // Cast filter to unknown: Astra TS types don't expose $regex/$elemMatch
    // but the underlying API supports them.
    collection
      .find(
        {
          $or: [
            { title: { $regex: q, $options: 'i' } },
            { notes: { $regex: q, $options: 'i' } },
            { transcript: { $regex: q, $options: 'i' } },
            { tags: { $elemMatch: { $regex: q, $options: 'i' } } },
          ],
        } as unknown as Parameters<typeof collection.find>[0],
        { limit: KEYWORD_LIMIT },
      )
      .toArray(),
  ]);

  // Merge and deduplicate
  // Vector results carry a $similarity score (0-1); keyword hits get a fixed boost of 0.5
  const scoreMap = new Map<string, { doc: Recording; score: number }>();

  for (const doc of vectorResults) {
    const sim = (doc as Recording & { $similarity?: number }).$similarity ?? 0;
    scoreMap.set(doc._id, { doc, score: sim });
  }

  for (const doc of keywordResults) {
    const existing = scoreMap.get(doc._id);
    if (existing) {
      existing.score += 0.5; // boost for appearing in both
    } else {
      scoreMap.set(doc._id, { doc, score: 0.5 });
    }
  }

  const merged = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);

  return NextResponse.json(merged);
}
