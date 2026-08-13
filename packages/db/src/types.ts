export interface RecordingLocation {
  coords: { lat: number; lng: number } | null;
  placeName: string | null;
}

export type RecordingStatus = 'processing' | 'ready' | 'error';

export interface Recording {
  _id: string;
  title: string;
  createdAt: string; // ISO timestamp
  duration: number; // seconds
  audioUrl: string; // Vercel Blob URL
  location: RecordingLocation | null;
  status: RecordingStatus;
  transcript: string | null; // full SRT text; null while processing
  summary: string | null; // null while processing
  keyTakeaways: string[];
  actionItems: string[];
  speakers: string[]; // diarization labels (post-MVP)
  tags: string[]; // editable
  notes: string; // editable freeform
  $vectorize?: string; // set to transcript text for Astra auto-embedding
}

/** Fields the client may update via PATCH */
export type RecordingPatch = Partial<
  Pick<Recording, 'title' | 'tags' | 'notes'> & {
    'location.placeName': string;
  }
>;
