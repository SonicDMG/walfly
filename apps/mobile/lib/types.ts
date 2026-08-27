/**
 * types.ts
 *
 * Local mirror of the wire contract the Next.js API speaks — the Recording
 * document, the pipeline vocabulary, and the request/response bodies.
 *
 * These deliberately MIRROR @walfly/db instead of importing it: that package's
 * entry point pulls in the Astra driver, and Metro would happily bundle it into
 * the client. Keep the two in sync by hand — the wire format is the contract,
 * not the TypeScript declaration.
 */

export interface RecordingLocation {
  coords: { lat: number; lng: number } | null;
  placeName: string | null;
}

export type RecordingStatus = 'uploaded' | 'transcribing' | 'enriching' | 'ready' | 'failed';

export type PipelineStage = 'submit' | 'transcribe' | 'enrich' | 'done';

export const NON_TERMINAL_STATUSES: readonly RecordingStatus[] = [
  'uploaded',
  'transcribing',
  'enriching',
];

export function isNonTerminal(status: RecordingStatus): boolean {
  return NON_TERMINAL_STATUSES.includes(status);
}

export interface Recording {
  _id: string;
  title: string;
  createdAt: string;
  duration: number;
  audioUrl: string;
  audioContentType: string;
  location: RecordingLocation | null;
  status: RecordingStatus;
  doclingTaskId: string | null;
  submittedAt: number | null;
  leaseUntil: number;
  failedStage: PipelineStage | null;
  error: string | null;
  transcript: string | null;
  summary: string | null;
  keyTakeaways: string[];
  actionItems: string[];
  speakers: string[];
  tags: string[];
  notes: string;
  searchTokens: string[];
}

/** Projected shape returned by GET /api/recordings. */
export type RecordingSummary = Pick<
  Recording,
  | '_id'
  | 'title'
  | 'createdAt'
  | 'duration'
  | 'status'
  | 'tags'
  | 'summary'
  | 'location'
  | 'audioUrl'
  | 'audioContentType'
  | 'error'
>;

/** Fields a client may change. `placeName` maps to the nested location field. */
export interface RecordingPatch {
  title?: string;
  tags?: string[];
  notes?: string;
  placeName?: string;
}

/** GET /api/recordings/upload */
export interface UploadCapabilities {
  maxUploadBytes: number;
  storage: 'blob' | 'local';
  acceptedMimeTypes: string[];
}

/** 201 body of POST /api/recordings/upload */
export interface UploadResponse {
  id: string;
  status: 'uploaded';
  audioUrl: string;
  audioContentType: string;
}

/** 200 body of POST /api/recordings/{id}/process */
export interface ProcessResponse {
  id: string;
  status: RecordingStatus;
  stage: PipelineStage;
  error: string | null;
  retryAfterMs: number;
}

export interface ApiError {
  error: string;
  code?: string;
}
