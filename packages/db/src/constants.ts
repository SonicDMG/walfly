/**
 * constants.ts
 *
 * Single source of truth for identifiers shared by the schema seeder, the
 * collection accessor, and the capability probe.
 */
export const RECORDINGS_COLLECTION = 'recordings';
export const RECORDING_CHUNKS_COLLECTION = 'recording_chunks';
export const VECTOR_DIMENSION = 1024;
export const VECTOR_MODEL = 'nvidia/nv-embedqa-e5-v5';
export const RERANK_MODEL = 'nvidia/llama-3.2-nv-rerankqa-1b-v2';
/** nv-embedqa-e5-v5 caps input at 512 tokens; ~1500 chars is a safe English bound. */
export const VECTORIZE_MAX_CHARS = 1500;
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
