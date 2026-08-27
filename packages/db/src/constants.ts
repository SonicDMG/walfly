/**
 * constants.ts
 *
 * Single source of truth for identifiers shared by the schema seeder, the
 * collection accessor, and the capability probe.
 */
export const RECORDINGS_COLLECTION = 'recordings';
export const VECTOR_DIMENSION = 1024;
export const VECTOR_MODEL = 'nvidia/nv-embedqa-e5-v5';
export const RERANK_MODEL = 'nvidia/llama-3.2-nv-rerankqa-1b-v2';
/** nv-embedqa-e5-v5 caps input at 512 tokens; ~1500 chars is a safe English bound. */
export const VECTORIZE_MAX_CHARS = 1500;
export const INDEXED_STRING_MAX_CHARS = 300;
export const MAX_TAGS = 32;
export const MAX_TAG_CHARS = 64;
export const MAX_SEARCH_TOKENS = 200;
export const INDEXING_DENY = [
  'transcript', 'summary', 'notes', 'keyTakeaways', 'actionItems',
  'audioUrl', 'speakers', 'error', 'doclingTaskId',
] as const;
