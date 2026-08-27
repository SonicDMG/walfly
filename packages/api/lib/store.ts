/**
 * store.ts
 *
 * Every Astra write the recording pipeline performs, in one place. The
 * functions are deliberately narrow — one per state transition — because the
 * pipeline is a resumable state machine whose durability comes entirely from
 * each step persisting its result before returning.
 *
 * Two Data API limits shape the writes here and are non-negotiable:
 *   - `$vectorize` is embedded by nvidia/nv-embedqa-e5-v5, which hard-caps
 *     input at 512 tokens, so it only ever receives a bounded title/summary
 *     blob and NEVER the transcript; exceeding it fails the whole update.
 *   - `$lexical` is unbounded but is a region-limited preview feature, so it is
 *     only written when the runtime capability probe says the collection has it.
 *
 * Pipeline diagnostics go to `error`/`failedStage`, never to `notes`, which
 * belongs to the user.
 */

import type { EnrichResult } from '@/lib/enrich';
import {
  buildSearchTokens,
  buildVectorizeText,
  clampIndexedString,
  clampTags,
  getCollectionCapabilities,
  getRecordingsCollection,
} from '@walfly/db';
import type { PipelineRecord, PipelineStage, Recording, RecordingStatus } from '@walfly/db';

/** `error` is excluded from indexing, but a runaway provider dump helps nobody. */
const MAX_ERROR_CHARS = 4000;

export interface CreateRecordingInput {
  id: string;
  createdAt: string;               // ISO
  duration: number;                // seconds
  audioUrl: string;
  audioContentType: string;
  lat: number | null;
  lng: number | null;
  placeName: string | null;
}

/** Inserts the initial document. The client kicks /process to advance it. */
export async function createRecording(input: CreateRecordingInput): Promise<void> {
  const collection = getRecordingsCollection();

  const hasCoords = typeof input.lat === 'number' && typeof input.lng === 'number';
  // Always an object, never null: PATCH writes $set['location.placeName'], and a
  // dotted path whose parent is a scalar null has no sub-document to write into.
  const location: Recording['location'] = {
    coords: hasCoords ? { lat: input.lat as number, lng: input.lng as number } : null,
    placeName: input.placeName ? clampIndexedString(input.placeName) : null,
  };

  const doc: Recording = {
    _id: input.id,
    title: clampIndexedString(`Recording ${new Date(input.createdAt).toLocaleString()}`),
    createdAt: input.createdAt,
    duration: input.duration,
    audioUrl: input.audioUrl,
    audioContentType: input.audioContentType,
    location,
    status: 'uploaded',
    doclingTaskId: null,
    submittedAt: null,
    leaseUntil: 0,
    attempts: 0,
    failedStage: null,
    error: null,
    transcript: null,
    summary: null,
    keyTakeaways: [],
    actionItems: [],
    speakers: [],
    tags: [],
    notes: '',
    searchTokens: [],
  };

  console.log(`[Astra] inserting recording ${input.id} (${input.duration}s, ${input.audioContentType})`);
  await collection.insertOne(doc);
  console.log(`[Astra] ${input.id} inserted → status=uploaded`);
}

/** The subset of fields one pipeline tick needs. Long fields stay unprojected. */
export async function getPipelineRecord(id: string): Promise<PipelineRecord | null> {
  const collection = getRecordingsCollection();

  console.log(`[Astra] fetching pipeline record ${id}`);
  const doc = await collection.findOne(
    { _id: id },
    {
      projection: {
        _id: 1,
        status: 1,
        audioUrl: 1,
        audioContentType: 1,
        doclingTaskId: 1,
        transcript: 1,
        leaseUntil: 1,
        submittedAt: 1,
        attempts: 1,
      },
    },
  );

  if (!doc) {
    console.log(`[Astra] ${id} not found`);
    return null;
  }

  console.log(`[Astra] ${id} fetched → status=${doc.status} attempts=${doc.attempts}`);
  return {
    _id: doc._id,
    status: doc.status,
    audioUrl: doc.audioUrl,
    audioContentType: doc.audioContentType,
    doclingTaskId: doc.doclingTaskId ?? null,
    transcript: doc.transcript ?? null,
    leaseUntil: typeof doc.leaseUntil === 'number' ? doc.leaseUntil : 0,
    submittedAt: typeof doc.submittedAt === 'number' ? doc.submittedAt : null,
    attempts: typeof doc.attempts === 'number' ? doc.attempts : 0,
  };
}

/**
 * Compare-and-set lease acquisition. Only the caller that flips `leaseUntil`
 * does the long work; an expired lease is reclaimable, which is exactly what
 * makes a crash mid-step recoverable.
 */
export async function acquireLease(
  id: string,
  expectedStatus: RecordingStatus,
  leaseMs: number,
): Promise<boolean> {
  const collection = getRecordingsCollection();
  const now = Date.now();

  console.log(`[Astra] acquiring lease for ${id} (status=${expectedStatus}, duration=${leaseMs}ms)`);
  const result = await collection.updateOne(
    { _id: id, status: expectedStatus, leaseUntil: { $lt: now } },
    { $set: { leaseUntil: now + leaseMs } },
  );

  const acquired = result.matchedCount === 1;
  console.log(`[Astra] lease for ${id}: ${acquired ? 'acquired' : 'not acquired (already held or status mismatch)'}`);
  return acquired;
}

/** Frees the lease so the next tick can pick the job up immediately. */
export async function releaseLease(id: string): Promise<void> {
  const collection = getRecordingsCollection();
  await collection.updateOne({ _id: id }, { $set: { leaseUntil: 0 } });
}

/** uploaded → transcribing. Persists the task id before any polling happens. */
export async function storeDoclingTaskId(id: string, taskId: string): Promise<void> {
  const collection = getRecordingsCollection();

  const result = await collection.updateOne(
    { _id: id },
    {
      $set: {
        doclingTaskId: taskId,
        status: 'transcribing',
        submittedAt: Date.now(),
        leaseUntil: 0,
        attempts: 0,
      },
    },
  );

  if (result.matchedCount === 0) {
    throw new Error(`Recording ${id} disappeared before the Docling task id could be stored`);
  }
}

/**
 * transcribing → enriching. The Docling result endpoint is single-use, so this
 * must succeed in the same request that fetched the transcript — hence the
 * throw on a missed match rather than a silent no-op.
 */
export async function storeTranscript(id: string, transcript: string): Promise<void> {
  const collection = getRecordingsCollection();

  console.log(`[Astra] storing transcript for ${id} (${transcript.length} chars) → status=enriching`);
  const result = await collection.updateOne(
    { _id: id },
    { $set: { transcript, status: 'enriching', leaseUntil: 0, attempts: 0 } },
  );

  if (result.matchedCount === 0) {
    throw new Error(`Recording ${id} not found while storing its transcript`);
  }
  console.log(`[Astra] ${id} transcript stored`);
}

/** enriching → ready. Writes the bounded embedding text and the search fields. */
export async function storeEnrichment(
  id: string,
  transcript: string,
  enrichment: EnrichResult,
): Promise<void> {
  const collection = getRecordingsCollection();
  console.log(`[Astra] fetching collection capabilities for ${id}`);
  const capabilities = await getCollectionCapabilities();
  console.log(`[Astra] capabilities: lexical=${capabilities.lexical} rerank=${capabilities.rerank} known=${capabilities.known}`);

  const title = clampIndexedString(enrichment.title.trim() || 'Untitled recording');
  const tags = clampTags(enrichment.tags);

  // `any` values: the driver types $set as `Partial<Schema> & SomeDoc`, and the
  // reserved `$lexical` key is conditional, so the object is built untyped.
  const $set: Record<string, any> = {
    title,
    summary: enrichment.summary,
    keyTakeaways: enrichment.keyTakeaways,
    actionItems: enrichment.actionItems,
    speakers: enrichment.speakers,
    tags,
    transcript,
    status: 'ready',
    error: null,
    failedStage: null,
    leaseUntil: 0,
    attempts: 0,
    searchTokens: buildSearchTokens(
      [title, enrichment.summary, enrichment.keyTakeaways.join(' '), tags.join(' '), transcript].join(' '),
    ),
    // Bounded: the embedding provider rejects anything over 512 tokens and the
    // rejection fails this entire update.
    $vectorize: buildVectorizeText({
      title,
      summary: enrichment.summary,
      keyTakeaways: enrichment.keyTakeaways,
      tags,
    }),
  };

  // Unbounded by design: $lexical is exempt from the indexed-string limit.
  const lexical = [title, tags.join(' '), transcript].filter(Boolean).join('\n');

  // A missing $lexical is unrecoverable without a backfill, whereas a rejected
  // update is retryable — so when the capability probe could not answer, the
  // field is written optimistically and dropped only if Astra actually refuses.
  const attemptLexical = capabilities.lexical || !capabilities.known;

  const vectorizeText = $set.$vectorize as string;
  console.log(`[Astra] ${id} writing enrichment — title="${enrichment.title}" vectorize=${vectorizeText.length} chars lexical=${attemptLexical}`);

  let result = await tryUpdate(attemptLexical ? { ...$set, $lexical: lexical } : $set);

  if (!result.ok) {
    if (!attemptLexical || capabilities.lexical) throw result.error;
    console.warn(
      `[Astra] ${id}: the collection rejected $lexical, retrying without it:`,
      result.error instanceof Error ? result.error.message : result.error,
    );
    result = await tryUpdate($set);
    if (!result.ok) throw result.error;
  }

  if (result.matchedCount === 0) {
    throw new Error(`Recording ${id} not found while storing its enrichment`);
  }
  console.log(`[Astra] ${id} enrichment stored → status=ready`);

  async function tryUpdate(
    update: Record<string, any>,
  ): Promise<{ ok: true; matchedCount: number } | { ok: false; error: unknown; matchedCount: number }> {
    try {
      const res = await collection.updateOne({ _id: id }, { $set: update });
      return { ok: true, matchedCount: res.matchedCount };
    } catch (error) {
      return { ok: false, error, matchedCount: 0 };
    }
  }
}

/**
 * A transient failure on a step that is worth retrying. The status is left
 * untouched, the lease is freed so the next tick can pick the job straight back
 * up, and the attempt counter is what eventually converts a persistent problem
 * into a real failure instead of an endless loop.
 */
export async function recordTransientFailure(
  id: string,
  stage: PipelineStage,
  message: string,
): Promise<void> {
  const collection = getRecordingsCollection();

  console.log(`[Astra] recording transient failure for ${id} at stage=${stage}`);
  await collection.updateOne(
    { _id: id },
    {
      $set: { leaseUntil: 0, failedStage: stage, error: message.slice(0, MAX_ERROR_CHARS) },
      $inc: { attempts: 1 },
    },
  );
}

/** Terminal failure. Keeps the provider's own diagnostics; never touches `notes`. */
export async function storeFailure(
  id: string,
  stage: PipelineStage,
  message: string,
): Promise<void> {
  const collection = getRecordingsCollection();

  console.log(`[Astra] recording terminal failure for ${id} at stage=${stage}: ${message.slice(0, 200)}`);
  await collection.updateOne(
    { _id: id },
    {
      $set: {
        status: 'failed',
        failedStage: stage,
        error: message.slice(0, MAX_ERROR_CHARS),
        leaseUntil: 0,
      },
    },
  );
}
