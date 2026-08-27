/**
 * transcribe.ts
 *
 * Calls the local Python sidecar (packages/api/sidecar/transcribe_sidecar.py)
 * which imports docling directly and runs Whisper Turbo via AsrPipeline.
 *
 * The sidecar exposes POST /v1/transcribe — a synchronous endpoint that blocks
 * until transcription is complete and returns {"markdown": "..."}.  This matches
 * the single-call contract the pipeline expects from transcribeAudio().
 *
 * Configuration:
 *   SIDECAR_URL  — base URL of the sidecar (default: http://localhost:5002)
 *
 * Start the sidecar before running the API:
 *   cd packages/api/sidecar && uv run python transcribe_sidecar.py
 */

import { normalizeAudioForAsr } from './docling';
import { loadAudio } from './storage';

const TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — whisper can be slow

export class TranscriptionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'TranscriptionError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
  }
}

export function isTranscriptionConfigured(): boolean {
  return true; // sidecar has no required credentials
}

function sidecarUrl(): string {
  return (process.env.SIDECAR_URL ?? 'http://localhost:5002').replace(/\/+$/, '');
}

/**
 * Loads the stored audio, normalises the container, POSTs it to the sidecar,
 * and returns the timestamped markdown transcript.
 */
export async function transcribeAudio(audioUrl: string): Promise<string> {
  const { bytes } = await loadAudio(audioUrl);
  const normalized = normalizeAudioForAsr(bytes, 'recording');

  const form = new FormData();
  form.append(
    'files',
    new Blob([normalized.bytes as unknown as BlobPart], { type: normalized.mime }),
    normalized.filename,
  );

  const url = `${sidecarUrl()}/v1/transcribe`;
  console.log(`[Docling local / Whisper Turbo] → POST ${url} file=${normalized.filename} bytes=${normalized.bytes.byteLength}`);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (cause) {
    const isTimeout = cause instanceof Error &&
      (cause.name === 'TimeoutError' || cause.name === 'AbortError');
    throw new TranscriptionError(
      isTimeout ? 'timeout' : 'transient',
      `Sidecar request failed: ${String(cause)}`,
      { retryable: true, cause },
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    throw new TranscriptionError(
      'transient',
      `Sidecar returned HTTP ${res.status}: ${body.slice(0, 300)}`,
      { retryable },
    );
  }

  let json: { markdown?: string };
  try {
    json = await res.json() as { markdown?: string };
  } catch (cause) {
    throw new TranscriptionError('transient', 'Sidecar returned invalid JSON', { retryable: true, cause });
  }

  const markdown = json.markdown?.trim();
  if (!markdown) {
    throw new TranscriptionError('empty_transcript', 'Sidecar returned an empty transcript', { retryable: false });
  }

  console.log(`[Docling local / Whisper Turbo] ✓ transcript ${markdown.length} chars`);
  return markdown;
}
