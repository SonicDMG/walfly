/**
 * recoverClient.ts
 *
 * Delivery of a local buffer to the server: probe → upload → complete, exactly
 * the flow the API's `/recover` routes implement. Idempotent at every step —
 * the probe is safe to repeat, the upload target is deterministic, and
 * `/complete` converges duplicate deliveries on one attach.
 *
 * Outcomes tell the caller whether the local buffer may be deleted:
 *   'delivered' | 'already'  → delete the buffer
 *   'skipped'                → delete the buffer (nothing needed / conflict lost)
 *   'retry'                  → keep it; the sweep will try again
 */

import { Platform } from 'react-native';
import { apiFetch, apiUrl } from './api';
import type { LocalBuffer, LocalBufferFile } from './localBuffer';

export type TranscriptSource = 'stream' | 'batch';

export interface DeliverResult {
  status: 'delivered' | 'already' | 'skipped' | 'retry';
  transcriptSource?: TranscriptSource | null;
  error?: string;
}

interface RecoverStateResponse {
  id: string;
  needed: boolean;
  reason: string;
  mode: 's3' | 'local';
  pathname: string;
  uploadUrl: string;
  object: { url: string; bytes: number; sizeMatches: boolean | null } | null;
}

export interface DeliverInput {
  recordingId: string;
  buffer: LocalBuffer;
  file: LocalBufferFile;
  /** Client-estimated audio the sidecar never consumed (unacked + dropped frames). */
  gapMs: number | null;
  prefer?: 'auto' | 'stream' | 'batch';
  createdAt?: string;
  clientAttempts?: number;
}

export async function deliverLocalBuffer(input: DeliverInput): Promise<DeliverResult> {
  const { recordingId } = input;
  try {
    const probeRes = await apiFetch(
      apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/recover?bytes=${input.file.bytes}&ext=${input.file.ext}`),
    );
    if (!probeRes.ok) {
      return { status: 'retry', error: `recover probe returned ${probeRes.status}` };
    }
    const state = (await probeRes.json()) as RecoverStateResponse;

    if (!state.needed) return { status: 'skipped' };

    if (state.object?.sizeMatches !== true) {
      await uploadRecoveredAudio(recordingId, input.buffer, input.file);
    }

    const completeRes = await apiFetch(
      apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/recover/complete`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pathname: state.pathname,
          bytes: input.file.bytes,
          duration: input.file.durationSec,
          gapMs: input.gapMs,
          prefer: input.prefer ?? 'auto',
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
          ...(typeof input.clientAttempts === 'number' ? { clientAttempts: input.clientAttempts } : {}),
        }),
      },
    );

    if (completeRes.ok) {
      const body = (await completeRes.json()) as { transcriptSource: TranscriptSource | null; alreadyAttached?: boolean };
      return {
        status: body.alreadyAttached ? 'already' : 'delivered',
        transcriptSource: body.transcriptSource ?? null,
      };
    }

    const errBody = (await completeRes.json().catch(() => ({}))) as { code?: string; error?: string };
    if (completeRes.status === 409 && (errBody.code === 'object_missing' || errBody.code === 'size_mismatch')) {
      return { status: 'retry', error: errBody.code };
    }
    if (completeRes.status === 409 && errBody.code === 'audio_conflict') {
      // Another delivery already attached audio; ours is residue.
      return { status: 'skipped', error: 'audio_conflict' };
    }
    return { status: 'retry', error: errBody.error ?? `complete returned ${completeRes.status}` };
  } catch (err) {
    return { status: 'retry', error: err instanceof Error ? err.message : String(err) };
  }
}

/** One whole-file POST — the API has no request-body cap in any storage mode. */
async function uploadRecoveredAudio(
  recordingId: string,
  buffer: LocalBuffer,
  file: LocalBufferFile,
): Promise<void> {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const blob = await buffer.getBlob();
    if (!blob) throw new Error('local buffer is not readable for upload');
    form.append('audio', blob, `${recordingId}.${file.ext}`);
  } else {
    const uri = buffer.getUri();
    if (!uri) throw new Error('local buffer has no file uri');
    form.append('audio', { uri, name: `${recordingId}.${file.ext}`, type: 'audio/wav' } as unknown as Blob);
  }
  form.append('duration', String(file.durationSec));

  const res = await apiFetch(apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/recover/audio`), {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`recover/audio returned ${res.status}: ${text.slice(0, 200)}`);
  }
}
