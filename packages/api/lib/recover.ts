/**
 * recover.ts
 *
 * The stateful half of the local-buffer recovery path: answers "does this
 * recording still need its buffered audio?" without mutating anything, so the
 * client can safely probe on every launch and every retry.
 *
 * The pure naming/policy rules live in `recoverPolicy.ts`; attaching the bytes
 * lives in `store.ts` (`attachRecoveredAudio`).
 */

import {
  LOCAL_AUDIO_URL_PREFIX,
  contentTypeForExtension,
  statStoredAudio,
  storageMode,
} from '@/lib/storage';
import {
  RECOVER_MAX_BYTES,
  normalizeExt,
  recoverPathname,
  type TranscriptSource,
} from '@/lib/recoverPolicy';
import { getRecordingsV2Collection } from '@walfly/db';

export interface RecoverObjectState {
  url: string;
  bytes: number;
  /** null when the client did not report its byte count. */
  sizeMatches: boolean | null;
}

export type RecoverReason =
  | 'audio_missing'
  | 'object_present'
  | 'already_attached'
  | 'terminal'
  | 'unknown_recording';

export interface RecoverState {
  id: string;
  needed: boolean;
  reason: RecoverReason;
  status: string | null;
  mode: 'blob' | 'local';
  pathname: string;
  contentType: string;
  /** Present in blob mode only; the client POSTs the SDK body here. */
  uploadUrl: string | null;
  maxBytes: number;
  object: RecoverObjectState | null;
  transcriptSource: TranscriptSource | null;
  retryAfterMs: number;
}

export interface RecoverStateInput {
  bytes?: number | null;
  ext?: string | null;
}

export async function getRecoverState(id: string, input: RecoverStateInput = {}): Promise<RecoverState> {
  const ext = normalizeExt(input.ext);
  const pathname = recoverPathname(id, ext);
  const mode = storageMode();
  const base = {
    id,
    mode,
    pathname,
    contentType: contentTypeForExtension(ext),
    uploadUrl: mode === 'blob' ? `/api/recordings/${encodeURIComponent(id)}/recover/upload` : null,
    maxBytes: RECOVER_MAX_BYTES,
    retryAfterMs: 0,
  } as const;

  const collection = getRecordingsV2Collection();
  const doc = await collection.findOne(
    { _id: id },
    {
      projection: {
        status: 1,
        audioUrl: 1,
        duration: 1,
        receivedChunks: 1,
        recover: 1,
        transcriptSource: 1,
      },
    },
  );

  const stored = await statStoredAudio(pathname);
  const object: RecoverObjectState | null = stored
    ? {
        url: stored.url,
        bytes: stored.bytes,
        sizeMatches: typeof input.bytes === 'number' ? stored.bytes === input.bytes : null,
      }
    : null;

  if (!doc) {
    // Case C3: the buffer's recording doc never made it (or was deleted). The
    // client may still want to re-create it — trust level matches /session.
    return { ...base, needed: true, reason: 'unknown_recording', status: null, object, transcriptSource: null };
  }

  const transcriptSource = (doc.transcriptSource as TranscriptSource | undefined) ?? null;
  const attached = Boolean(doc.recover?.attachedAt) || isRealAudioUrl(doc.audioUrl);
  const status = String(doc.status);

  if (attached) {
    return { ...base, needed: false, reason: 'already_attached', status, object, transcriptSource };
  }
  if (status === 'ready' || status === 'failed' || status === 'transcribing' || status === 'enriching') {
    // A terminal or in-flight doc must not be re-attached behind the pipeline's
    // back; a user wanting a re-run needs an explicit action (not built yet).
    return { ...base, needed: false, reason: 'terminal', status, object, transcriptSource };
  }

  return {
    ...base,
    needed: true,
    reason: object ? 'object_present' : 'audio_missing',
    status,
    object,
    transcriptSource,
  };
}

/** True for a URL that actually points at audio (never the live-session placeholder). */
function isRealAudioUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.includes('-session')) return false;
  return /^https?:\/\//i.test(url) || url.startsWith(LOCAL_AUDIO_URL_PREFIX);
}
