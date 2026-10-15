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
import { mergeMusic } from '@/lib/music';
import { chooseTranscriptSource, type RecoverPreference, type TranscriptSource } from '@/lib/recoverPolicy';
import { statStoredAudio } from '@/lib/storage';
import { formatSegmentLine } from '@/lib/transcript';
import type { MusicDetection, RecordingRecovery } from '@walfly/db';
import {
  buildSearchTokens,
  buildVectorizeText,
  clampIndexedString,
  clampTags,
  clampUtf8Bytes,
  getCollectionCapabilities,
  getRecordingsV2Collection,
  ensureRecordingChunksV2Collection,
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

export interface CreateLiveSessionInput {
  id: string;
  createdAt: string;
  lat: number | null;
  lng: number | null;
  placeName: string | null;
  title?: string;
}

/** Initializes a live streaming recording session with checkpoint tracking. */
export async function createLiveSession(input: CreateLiveSessionInput): Promise<void> {
  const collection = getRecordingsV2Collection();

  const hasCoords = typeof input.lat === 'number' && typeof input.lng === 'number';
  const location: Recording['location'] = {
    coords: hasCoords ? { lat: input.lat as number, lng: input.lng as number } : null,
    placeName: input.placeName ? clampIndexedString(input.placeName) : null,
  };

  const doc: Recording = {
    _id: input.id,
    title: clampIndexedString(input.title?.trim() || `Live Recording ${new Date(input.createdAt).toLocaleString()}`),
    createdAt: input.createdAt,
    duration: 0,
    audioUrl: `/api/recordings/audio/${input.id}-session`,
    audioContentType: 'audio/mp4',
    location,
    status: 'recording',
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
    isLiveSession: true,
    checkpointSeq: 0,
    totalExpectedChunks: 0,
    receivedChunks: 0,
    lastChunkIndex: -1,
  };

  console.log(`[Astra] creating live session recording ${input.id}`);
  await collection.insertOne(doc);
  console.log(`[Astra] live session ${input.id} initialized → status=recording`);
}

/** Finalizes a live session and transitions it to processing. */
export async function finalizeLiveSession(
  id: string,
  totalExpectedChunks?: number,
  duration?: number,
): Promise<void> {
  const collection = getRecordingsV2Collection();
  console.log(`[Astra] finalizing live session ${id}`);

  const $set: Record<string, any> = {
    status: 'uploaded',
  };
  if (typeof totalExpectedChunks === 'number') {
    $set.totalExpectedChunks = totalExpectedChunks;
  }
  if (typeof duration === 'number') {
    $set.duration = duration;
  }

  const res = await collection.updateOne(
    { _id: id, isLiveSession: true },
    { $set },
  );

  if (res.matchedCount === 0) {
    throw new Error(`Live recording session ${id} not found`);
  }
}

export interface AppendSegmentInput {
  recordingId: string;
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Persists one finalized streaming segment (a sidecar `segment` event) as an
 * independent document in `recording_chunks_v2` — the same write-ahead log the
 * pipeline always used, now fed by the sidecar instead of client chunk uploads —
 * and updates the parent recording's stitched transcript.
 *
 * The client ACKs a segment only after this write succeeds, and posts are
 * serialized per recording, so the parent append is optimistic (one read, one
 * write). Any index mismatch (a retry, a replay after reconnect, a lost ack)
 * falls back to a full re-stitch from the segment log, which makes the whole
 * path idempotent.
 */
export async function recordSegmentTranscript(
  input: AppendSegmentInput,
): Promise<{ receivedChunks: number }> {
  const recordingsCollection = getRecordingsV2Collection();
  const segmentsCollection = await ensureRecordingChunksV2Collection();

  const doc = await recordingsCollection.findOne(
    { _id: input.recordingId },
    { projection: { transcript: 1, lastChunkIndex: 1, receivedChunks: 1 } },
  );
  if (!doc) {
    throw new Error(`Recording ${input.recordingId} not found`);
  }

  const segmentId = `${input.recordingId}_chunk_${String(input.chunkIndex).padStart(6, '0')}`;
  const line = clampUtf8Bytes(formatSegmentLine(input.startMs, input.endMs, input.text));

  // 1. Upsert the segment document (no $vectorize — pure write-ahead log).
  await segmentsCollection.updateOne(
    { _id: segmentId },
    {
      $set: {
        recordingId: input.recordingId,
        chunkIndex: input.chunkIndex,
        duration: Math.max(0, (input.endMs - input.startMs) / 1000),
        offsetMs: input.startMs,
        startMs: input.startMs,
        endMs: input.endMs,
        status: 'transcribed' as const,
        transcript: line,
        deletedAt: new Date().toISOString(),
        silent: false,
      },
    },
    { upsert: true },
  );

  // 2. Append to the parent transcript (or rebuild when the index does not
  //    line up with the last recorded one).
  const previousTranscript = (doc.transcript as string | null | undefined) ?? '';
  const previousLast = typeof doc.lastChunkIndex === 'number' ? doc.lastChunkIndex : -1;
  const previousCount = typeof doc.receivedChunks === 'number' ? doc.receivedChunks : 0;

  // Fast path: compare-and-set on lastChunkIndex. A retry racing this post
  // moves the index first, so the CAS misses and we fall through to the
  // rebuild — the append can never double up on a duplicate POST.
  if (previousLast + 1 === input.chunkIndex) {
    const appended = previousTranscript ? `${previousTranscript}\n\n${line}` : line;
    const cas = await recordingsCollection.updateOne(
      { _id: input.recordingId, lastChunkIndex: previousLast },
      {
        $set: {
          transcript: appended,
          receivedChunks: previousCount + 1,
          lastChunkIndex: input.chunkIndex,
        },
      },
    );
    if (cas.matchedCount === 1) {
      return { receivedChunks: previousCount + 1 };
    }
    console.warn(`[Astra] ${input.recordingId}: segment ${input.chunkIndex} append raced; rebuilding transcript`);
  }

  // Rebuild path: re-stitch from the segment log (idempotent by construction).
  const cursor = segmentsCollection.find(
    { recordingId: input.recordingId },
    { sort: { chunkIndex: 1 } },
  );
  const allSegments = await cursor.toArray();
  const transcript = allSegments
    .map((segment) => segment.transcript)
    .filter(Boolean)
    .join('\n\n');
  const receivedChunks = allSegments.length;
  const lastChunkIndex = allSegments.reduce(
    (max, segment) => Math.max(max, typeof segment.chunkIndex === 'number' ? segment.chunkIndex : -1),
    -1,
  );

  await recordingsCollection.updateOne(
    { _id: input.recordingId },
    { $set: { transcript, receivedChunks, lastChunkIndex } },
  );

  return { receivedChunks };
}

export interface AttachRecoveredInput {
  recordingId: string;
  pathname: string;
  bytes: number;
  durationSec: number;
  gapMs: number | null;
  prefer: RecoverPreference;
  /** Used only when the recording document is missing (case C3). */
  createdAt?: string;
  lat?: number | null;
  lng?: number | null;
  placeName?: string | null;
  clientAttempts?: number;
}

export type AttachRecoveredResult =
  | { result: 'attached' | 'alreadyAttached'; audioUrl: string; transcriptSource: TranscriptSource; status: string }
  | { result: 'object_missing'; expected: number }
  | { result: 'size_mismatch'; expected: number; actual: number }
  | { result: 'audio_conflict'; audioUrl: string | null };

/**
 * Attaches audio delivered from the client's local buffer to its recording,
 * idempotently, and decides how the durable transcript is produced.
 *
 * Authority: the object (deterministic pathname) plus a read-value CAS on
 * `audioUrl` — the same pattern `recordSegmentTranscript` uses. Duplicate
 * deliveries converge; whoever loses the CAS gets `alreadyAttached` or
 * `audio_conflict` and never overwrites the winner.
 *
 * Recovery is a superset of /finalize: a `recording` doc that never finalized
 * becomes `uploaded` here, with `transcriptSource` chosen once.
 */
export async function attachRecoveredAudio(input: AttachRecoveredInput): Promise<AttachRecoveredResult> {
  const stored = await statStoredAudio(input.pathname);
  if (!stored) return { result: 'object_missing', expected: input.bytes };
  if (stored.bytes !== input.bytes) {
    return { result: 'size_mismatch', expected: input.bytes, actual: stored.bytes };
  }

  const collection = getRecordingsV2Collection();
  const nowIso = new Date().toISOString();
  const recover: RecordingRecovery = {
    source: 'local-buffer',
    attachedAt: nowIso,
    pathname: input.pathname,
    bytes: stored.bytes,
    durationSec: input.durationSec,
    gapMs: input.gapMs,
    attempts: 1,
    ...(typeof input.clientAttempts === 'number' ? { clientAttempts: input.clientAttempts } : {}),
  };

  const doc = await collection.findOne(
    { _id: input.recordingId },
    {
      projection: {
        status: 1, audioUrl: 1, transcript: 1, receivedChunks: 1, duration: 1,
        recover: 1, transcriptSource: 1,
      },
    },
  );

  if (!doc) {
    // Case C3: no document to attach to — the local buffer is the only copy.
    const source = chooseTranscriptSource({
      stitched: null,
      receivedChunks: 0,
      gapMs: input.gapMs,
      streamedDuration: 0,
      localDuration: input.durationSec,
      prefer: input.prefer,
    });
    const createdAt = input.createdAt ?? nowIso;
    const hasCoords = typeof input.lat === 'number' && typeof input.lng === 'number';
    const recoveredDoc: Recording = {
      _id: input.recordingId,
      title: clampIndexedString(`Recovered recording ${new Date(createdAt).toLocaleString()}`),
      createdAt,
      duration: input.durationSec,
      audioUrl: stored.url,
      audioContentType: stored.contentType,
      location: {
        coords: hasCoords ? { lat: input.lat as number, lng: input.lng as number } : null,
        placeName: input.placeName ? clampIndexedString(input.placeName) : null,
      },
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
      transcriptSource: source,
      recover,
    };
    console.log(`[Astra] inserting recovered recording ${input.recordingId} (${stored.bytes} bytes, source=${source})`);
    await collection.insertOne(recoveredDoc);
    return { result: 'attached', audioUrl: stored.url, transcriptSource: source, status: 'uploaded' };
  }

  const currentStatus = String(doc.status);
  const currentSource = (doc.transcriptSource as TranscriptSource | undefined) ?? null;

  if (doc.recover?.attachedAt) {
    await collection.updateOne({ _id: input.recordingId }, { $inc: { 'recover.attempts': 1 } });
    return {
      result: 'alreadyAttached',
      audioUrl: doc.audioUrl,
      transcriptSource: currentSource ?? 'batch',
      status: currentStatus,
    };
  }
  if (currentStatus !== 'recording' && currentStatus !== 'uploaded') {
    // The pipeline is already processing this doc; do not attach behind its back.
    return {
      result: 'alreadyAttached',
      audioUrl: doc.audioUrl,
      transcriptSource: currentSource ?? 'batch',
      status: currentStatus,
    };
  }

  const source = chooseTranscriptSource({
    stitched: (doc.transcript as string | null) ?? null,
    receivedChunks: typeof doc.receivedChunks === 'number' ? doc.receivedChunks : 0,
    gapMs: input.gapMs,
    streamedDuration: typeof doc.duration === 'number' ? doc.duration : 0,
    localDuration: input.durationSec,
    prefer: input.prefer,
  });

  // Compare-and-set on `status`, which is an indexed path — Astra refuses
  // filters on denied paths like `audioUrl`, so the guard is "the status I
  // read is still the status I write": a concurrent finalize/attach that
  // moved it first makes this miss, and the re-read below reports the winner.
  const cas = await collection.updateOne(
    { _id: input.recordingId, status: currentStatus },
    {
      $set: {
        audioUrl: stored.url,
        audioContentType: stored.contentType,
        duration: input.durationSec,
        status: 'uploaded',
        transcriptSource: source,
        recover,
        leaseUntil: 0,
      },
    },
  );

  if (cas.matchedCount === 1) {
    console.log(`[Astra] ${input.recordingId} recovered audio attached (${stored.bytes} bytes, source=${source})`);
    return { result: 'attached', audioUrl: stored.url, transcriptSource: source, status: 'uploaded' };
  }

  // Lost the race — re-read to see who won.
  console.warn(`[Astra] ${input.recordingId}: recovery attach raced; deferring to the winner`);
  const after = await collection.findOne(
    { _id: input.recordingId },
    { projection: { audioUrl: 1, recover: 1, transcriptSource: 1 } },
  );
  if (after?.recover?.attachedAt) {
    return {
      result: 'alreadyAttached',
      audioUrl: after.audioUrl,
      transcriptSource: (after.transcriptSource as TranscriptSource | undefined) ?? source,
      status: 'uploaded',
    };
  }
  return { result: 'audio_conflict', audioUrl: after?.audioUrl ?? null };
}

/** Inserts the initial document. The client kicks /process to advance it. */
export async function createRecording(input: CreateRecordingInput): Promise<void> {
  const collection = getRecordingsV2Collection();

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
  const collection = getRecordingsV2Collection();

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
        isLiveSession: 1,
        music: 1,
        transcriptSource: 1,
        receivedChunks: 1,
        duration: 1,
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
    isLiveSession: doc.isLiveSession ?? false,
    music: (doc.music as MusicDetection | undefined) ?? undefined,
    transcriptSource: doc.transcriptSource ?? undefined,
    receivedChunks: typeof doc.receivedChunks === 'number' ? doc.receivedChunks : undefined,
    duration: typeof doc.duration === 'number' ? doc.duration : 0,
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
  const collection = getRecordingsV2Collection();
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

/**
 * transcribing → enriching. Persists the transcript before enrichment so a
 * crash after this point never re-runs ASR.
 */
export async function storeTranscript(id: string, transcript: string): Promise<void> {
  const collection = getRecordingsV2Collection();

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
  music?: MusicDetection,
): Promise<void> {
  const collection = getRecordingsV2Collection();
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
    // Only write music when we have a result (standard upload). For live
    // sessions music=undefined so we leave whatever the chunk route stored.
    ...(music !== undefined ? { music } : {}),
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
  const collection = getRecordingsV2Collection();

  console.log(`[Astra] recording transient failure for ${id} at stage=${stage}`);
  await collection.updateOne(
    { _id: id },
    {
      $set: { leaseUntil: 0, failedStage: stage, error: message.slice(0, MAX_ERROR_CHARS) },
      $inc: { attempts: 1 },
    },
  );
}

/**
 * Merge-writes music detection results for a recording. Reads the current music
 * field, merges incoming matches using mergeMusic (dedup + fingerprint-wins
 * priority), then writes the combined result back. Called from the chunk route
 * and from the enrichment step so concurrent handlers never overwrite each other.
 */
export async function storeMusicDetection(id: string, incoming: MusicDetection): Promise<void> {
  const collection = getRecordingsV2Collection();

  // Read current music to merge rather than overwrite.
  const doc = await collection.findOne({ _id: id }, { projection: { music: 1 } });
  const existing = (doc?.music as MusicDetection | undefined);
  const mergedMatches = mergeMusic(existing?.matches ?? [], incoming.matches);
  const merged: MusicDetection = {
    detected: mergedMatches.length > 0,
    matches: mergedMatches,
    scannedAt: new Date().toISOString(),
  };

  await collection.updateOne({ _id: id }, { $set: { music: merged } });
  console.log(`[Astra] ${id} music detection stored — detected=${merged.detected} matches=${merged.matches.length}`);
}

/** Terminal failure. Keeps the provider's own diagnostics; never touches `notes`. */
export async function storeFailure(
  id: string,
  stage: PipelineStage,
  message: string,
): Promise<void> {
  const collection = getRecordingsV2Collection();

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
