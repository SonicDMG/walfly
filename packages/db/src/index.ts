/**
 * index.ts
 *
 * Public surface of @walfly/db: the Astra handle, the typed collection
 * accessor, the runtime capability probe, the bounded-text helpers, and the
 * document/state types every server-side set agrees on.
 */

export { getDb } from './client';
export { getRecordingsCollection } from './collections';
export { getCollectionCapabilities, resetCollectionCapabilities } from './capabilities';
export type { CollectionCapabilities } from './capabilities';
export * from './constants';
export * from './text';
export type {
  Recording, RecordingLocation, RecordingStatus, RecordingSummary,
  RecordingPatch, PipelineRecord, PipelineStage,
} from './types';
export { NON_TERMINAL_STATUSES } from './types';
