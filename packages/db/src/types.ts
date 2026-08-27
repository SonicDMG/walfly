/**
 * types.ts
 *
 * The Recording document shape and the pipeline state vocabulary. Every set in
 * the codebase agrees on these names; the mobile app mirrors them locally
 * rather than importing this package, so nothing pulls the Astra driver into
 * the client bundle.
 */

export interface RecordingLocation {
  coords: { lat: number; lng: number } | null;
  placeName: string | null;
}

/** Pipeline states. `uploaded`/`transcribing`/`enriching` are non-terminal. */
export type RecordingStatus = 'uploaded' | 'transcribing' | 'enriching' | 'ready' | 'failed';

export type PipelineStage = 'submit' | 'transcribe' | 'enrich' | 'done';

export const NON_TERMINAL_STATUSES: readonly RecordingStatus[] = ['uploaded', 'transcribing', 'enriching'];

export interface Recording {
  _id: string;
  title: string;
  createdAt: string;              // ISO 8601, always UTC with milliseconds
  duration: number;               // seconds
  audioUrl: string;               // absolute Blob URL, or /api/recordings/audio/<name> in local dev
  audioContentType: string;       // the container we actually stored, e.g. audio/mp4
  location: RecordingLocation | null;
  status: RecordingStatus;
  doclingTaskId: string | null;
  submittedAt: number | null;     // epoch ms when the Docling job was submitted
  leaseUntil: number;             // epoch ms; 0 = free. Guards long steps.
  attempts: number;               // consecutive transient failures on the current step
  failedStage: PipelineStage | null;
  error: string | null;           // pipeline diagnostics. NEVER written to `notes`.
  transcript: string | null;      // timestamped markdown from Docling ASR — NOT SRT
  summary: string | null;
  keyTakeaways: string[];
  actionItems: string[];
  speakers: string[];
  tags: string[];
  notes: string;                  // user freeform. The pipeline never writes here.
  searchTokens: string[];         // lowercased tokens for the portable keyword fallback
  $vectorize?: string;            // bounded (<= VECTORIZE_MAX_CHARS)
  $lexical?: string;              // full transcript; only when capabilities.lexical
}

/** Projected shape returned by GET /api/recordings. */
export type RecordingSummary = Pick<
  Recording,
  '_id' | 'title' | 'createdAt' | 'duration' | 'status' | 'tags' | 'summary'
  | 'location' | 'audioUrl' | 'audioContentType' | 'error'
>;

/** The subset of a Recording the pipeline reads on each tick. */
export type PipelineRecord = Pick<
  Recording,
  '_id' | 'status' | 'audioUrl' | 'audioContentType' | 'doclingTaskId'
  | 'transcript' | 'leaseUntil' | 'submittedAt' | 'attempts'
>;

/** Fields a client may change. `placeName` maps to the nested location field. */
export interface RecordingPatch {
  title?: string;
  tags?: string[];
  notes?: string;
  placeName?: string;
}
