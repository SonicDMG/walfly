/**
 * constants.ts
 *
 * Single source of truth for identifiers shared by the schema seeder, the
 * collection accessor, and the capability probe.
 */
export const RECORDINGS_COLLECTION = 'recordings';
export const RECORDING_CHUNKS_COLLECTION = 'recording_chunks';
/** V2 collections: clean two-collection design (see GitHub issue #34).
 *  Legacy v1 collections are left in place for posterity. */
export const RECORDINGS_V2_COLLECTION = 'recordings_v2';
export const RECORDING_CHUNKS_V2_COLLECTION = 'recording_chunks_v2';
export const VECTOR_DIMENSION = 1024;
export const VECTOR_MODEL = 'nvidia/nv-embedqa-e5-v5';
export const RERANK_MODEL = 'nvidia/llama-3.2-nv-rerankqa-1b-v2';
/** nv-embedqa-e5-v5 caps input at 512 tokens; ~750 chars is a safe bound (~3.5 chars/token average). */
export const VECTORIZE_MAX_CHARS = 750;
export const INDEXED_STRING_MAX_CHARS = 300;
/** Astra DB strict limit on indexed string properties is 8,000 bytes UTF-8; 7,500 gives safety margin. */
export const MAX_CHUNK_TRANSCRIPT_BYTES = 7500;
export const MAX_TAGS = 32;
export const MAX_TAG_CHARS = 64;
export const MAX_SEARCH_TOKENS = 200;
export const INDEXING_DENY = [
  'transcript', 'summary', 'notes', 'keyTakeaways', 'actionItems',
  'audioUrl', 'speakers', 'error', 'doclingTaskId',
] as const;
export const CHUNKS_INDEXING_DENY = [
  'transcript', 'audioUrl',
] as const;

/** V2 deny lists.
 *  recordings_v2: adds 'chunks' as belt-and-suspenders even though the array
 *  is removed in the new design — guards against accidental backfill.
 *  recording_chunks_v2: denies 'transcript' so raw ASR text is never indexed
 *  (eliminates the 8KB limit concern regardless of chunk length). */
export const INDEXING_DENY_V2 = [
  'transcript', 'summary', 'notes', 'keyTakeaways', 'actionItems',
  'audioUrl', 'speakers', 'error', 'doclingTaskId', 'chunks', 'music',
] as const;
export const CHUNKS_INDEXING_DENY_V2 = [
  'transcript', 'audioUrl',
] as const;
