/**
 * GET /api/moments/clusters
 *
 * Clusters recordings using TypeSafe JEV via OpenRouter.
 * Supports preset lenses (e.g. domain, intent) as well as dynamic clustering.
 * Results are cached in-memory with optional force-refresh.
 *
 * Query params:
 *   lens    - "dynamic" (default) | "domain" | "intent"
 *   refresh - "true" to bypass cache and recompute
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRecordingsCollection } from '@walfly/db';
import { clusterRecordingsWithJev, type ClusteredMomentsResult, PRESET_LENSES } from '@/lib/jev';
import { isLlmConfigured } from '@/lib/llm';

export const runtime = 'nodejs';

// In-memory cache for cluster results keyed by lens
const clusterCache = new Map<string, { result: ClusteredMomentsResult; cachedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lens = (searchParams.get('lens') || 'dynamic').toLowerCase();
  const forceRefresh = searchParams.get('refresh') === 'true';

  // Check cache if not forcing refresh
  if (!forceRefresh) {
    const cached = clusterCache.get(lens);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return NextResponse.json(cached.result);
    }
  }

  try {
    const collection = getRecordingsCollection();
    // Fetch ready recordings with metadata
    const cursor = collection.find(
      { status: 'ready' },
      {
        projection: {
          _id: 1,
          title: 1,
          summary: 1,
          tags: 1,
          keyTakeaways: 1,
        },
        sort: { createdAt: -1 },
        limit: 100,
      }
    );

    const docs = await cursor.toArray();
    const recordingsForClustering = docs.map((d) => ({
      id: d._id,
      title: d.title || 'Untitled moment',
      summary: d.summary,
      tags: Array.isArray(d.tags) ? d.tags : [],
      keyTakeaways: Array.isArray(d.keyTakeaways) ? d.keyTakeaways : [],
    }));

    const result = await clusterRecordingsWithJev(lens, recordingsForClustering);

    // Save to cache
    clusterCache.set(lens, { result, cachedAt: Date.now() });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[API /api/moments/clusters] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate moment clusters' },
      { status: 500 }
    );
  }
}
