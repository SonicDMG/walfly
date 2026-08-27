/**
 * transcribe.ts
 *
 * Provider-facing seam for speech-to-text. Sends the audio bytes directly to
 * the OpenAI Whisper transcriptions API — no server, no polling, no task IDs.
 * This mirrors the Python reference script (transcribe.py) which runs Whisper
 * in-process via the Docling Python library; here the equivalent is calling
 * the Whisper API synchronously from the pipeline.
 *
 * The call is a single awaited fetch: the pipeline leases the step for
 * LEASE_TRANSCRIBE_MS and gets back a markdown transcript in one shot.
 *
 * Response format "verbose_json" gives us word-level timestamps; we convert
 * them to the same "[time: a-b] text" paragraph format the rest of the app
 * expects (identical to what docling ASR emits).
 */

import { getWhisperModel, isWhisperConfigured, whisperClient } from './whisper';
import { loadAudio } from './storage';
import { normalizeAudioForAsr } from './docling';

export { isWhisperConfigured as isTranscriptionConfigured };

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

/**
 * Loads the stored audio, normalises the container, and calls the Whisper
 * transcriptions endpoint. Returns timestamped markdown in the same
 * "[time: a-b] text" format used throughout the rest of the app.
 *
 * Throws TranscriptionError on non-retryable failures (bad audio format,
 * auth errors) and on retryable failures (network timeouts, 5xx) so the
 * pipeline can decide whether to retry.
 */
export async function transcribeAudio(audioUrl: string): Promise<string> {
  const { bytes } = await loadAudio(audioUrl);
  const normalized = normalizeAudioForAsr(bytes, 'recording');

  const openai = whisperClient();
  const model = getWhisperModel();

  let result: Awaited<ReturnType<typeof openai.audio.transcriptions.create>>;
  try {
    result = await openai.audio.transcriptions.create({
      model,
      file: new File([normalized.bytes as unknown as BlobPart], normalized.filename, { type: normalized.mime }),
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
  } catch (cause) {
    const isTimeout =
      cause instanceof Error &&
      (cause.name === 'APIConnectionTimeoutError' ||
        cause.name === 'TimeoutError' ||
        cause.name === 'AbortError');

    if (isTimeout) {
      throw new TranscriptionError(
        'transient',
        `Whisper transcription timed out: ${String(cause)}`,
        { retryable: true, cause },
      );
    }

    // OpenAI SDK wraps HTTP errors as APIError subclasses
    const status = (cause as { status?: number }).status;
    if (typeof status === 'number') {
      if (status === 401 || status === 403) {
        throw new TranscriptionError(
          'auth',
          `Whisper API returned ${status} — check WHISPER_API_KEY`,
          { retryable: false, cause },
        );
      }
      if (status === 413 || status === 415) {
        throw new TranscriptionError(
          'unsupported_media',
          `Whisper API rejected the audio (${status}) — check format or file size`,
          { retryable: false, cause },
        );
      }
      if (status === 429 || status >= 500) {
        throw new TranscriptionError(
          'transient',
          `Whisper API returned ${status}`,
          { retryable: true, cause },
        );
      }
    }

    throw new TranscriptionError(
      'transient',
      `Whisper API call failed: ${String(cause)}`,
      { retryable: true, cause },
    );
  }

  return verboseJsonToMarkdown(result);
}

// ---------------------------------------------------------------------------

interface VerboseJsonSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface VerboseJsonResult {
  text?: string;
  segments?: VerboseJsonSegment[];
}

/**
 * Converts Whisper's verbose_json response to the "[time: a-b] text" paragraph
 * format that the rest of the app (including the LLM enrichment prompt) expects.
 * Falls back to the plain `text` field when no segments are present.
 */
function verboseJsonToMarkdown(result: VerboseJsonResult): string {
  const segments = result.segments;

  if (!segments?.length) {
    const text = result.text?.trim();
    if (!text) {
      throw new TranscriptionError('empty_transcript', 'Whisper returned an empty transcript');
    }
    return text;
  }

  const lines = segments
    .filter((s) => s.text?.trim())
    .map((s) => {
      const start = fmt(s.start ?? 0);
      const end = fmt(s.end ?? (s.start ?? 0));
      return `[time: ${start}-${end}] ${s.text!.trim()}`;
    });

  if (!lines.length) {
    throw new TranscriptionError('empty_transcript', 'Whisper returned segments with no text');
  }

  return lines.join('\n\n');
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}
