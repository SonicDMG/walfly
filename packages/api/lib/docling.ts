/**
 * docling.ts
 *
 * Client for Docling SaaS (docling-serve v1 API, as exposed by IBM Docling for
 * watsonx). Audio bytes are ALWAYS uploaded as multipart to
 * POST /v1/convert/file/async, so Docling never needs network reachability to
 * our audio storage — the identical code path works from localhost and Vercel.
 *
 * ASR is selected implicitly, by input format rather than by a request flag.
 * DocumentConverter's default format options map InputFormat.AUDIO to
 * AudioFormatOption, whose pipeline_cls is AsrPipeline, and InputFormat.AUDIO
 * covers exactly wav/mp3/m4a/aac/ogg/flac. The REST API's `pipeline` option
 * does have an "asr" value, but it defaults to "standard" and is documented as
 * choosing the pipeline "to process PDF or image files" — audio never consults
 * it. So the only thing that matters is that the bytes we send sniff as one of
 * those six audio containers.
 *
 * Note that the ASR model is NOT selectable over REST: AsrPipelineOptions
 * defaults to whisper_tiny and the conversion request exposes no asr_options,
 * so transcription quality is a property of the Docling deployment, not of
 * anything this client can send.
 */

export const DOCLING_MAX_BYTES = 100 * 1024 * 1024;

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 60_000;

export type DoclingErrorCode =
  | 'config'
  | 'unsupported_media'
  | 'rate_limited'
  | 'transient'
  | 'task_failed'
  | 'asr_unavailable'
  | 'empty_transcript'
  | 'not_found'
  | 'protocol';

export class DoclingError extends Error {
  readonly code: DoclingErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly taskId?: string;

  constructor(
    code: DoclingErrorCode,
    message: string,
    opts: { retryable?: boolean; httpStatus?: number; taskId?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'DoclingError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.httpStatus = opts.httpStatus;
    this.taskId = opts.taskId;
  }
}

export function doclingConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.DOCLING_SERVICE_URL?.replace(/\/+$/, '');
  const apiKey = process.env.DOCLING_API_KEY;
  if (!baseUrl) throw new DoclingError('config', 'Missing DOCLING_SERVICE_URL');
  if (!apiKey) throw new DoclingError('config', 'Missing DOCLING_API_KEY');
  return { baseUrl, apiKey };
}

export function isDoclingConfigured(): boolean {
  return Boolean(process.env.DOCLING_SERVICE_URL && process.env.DOCLING_API_KEY);
}

// --- container sniffing -----------------------------------------------------

export type AudioExt = 'wav' | 'mp3' | 'm4a' | 'aac' | 'ogg' | 'flac' | 'webm';

export interface AudioContainer {
  ext: AudioExt;
  mime: string;
}

/** MIME types Docling's ASR pipeline accepts, keyed by the extension we send. */
export const ASR_EXT_TO_MIME: Record<Exclude<AudioExt, 'webm'>, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};

/** MIME types the upload endpoint advertises to clients. Bytes remain authoritative. */
export const ACCEPTED_UPLOAD_MIME_TYPES: string[] = [
  'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/ogg', 'audio/opus',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/mpeg', 'audio/mp3',
  'audio/aac', 'audio/flac', 'audio/x-flac',
];

/** Identifies the container from magic bytes. Content always beats the filename. */
export function sniffAudioContainer(bytes: Uint8Array): AudioContainer | null {
  if (bytes.length < 16) return null;
  const at = (offset: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + len));

  if (at(0, 4) === 'RIFF' && at(8, 4) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (at(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (at(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { ext: 'webm', mime: 'audio/webm' };
  }
  if (at(4, 4) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (at(0, 3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

export interface NormalizedAudio {
  bytes: Uint8Array;
  mime: string;
  ext: AudioExt;
  filename: string;
}

/**
 * Validates that the bytes are an ASR-capable audio container and, for MPEG-4
 * files, rewrites the ftyp major brand to "M4A " so Docling's content sniffer
 * classifies them as audio/mp4 rather than video/mp4. The major brand is
 * advisory; the compatible-brands list is left untouched.
 */
export function normalizeAudioForAsr(input: Uint8Array, filenameHint = 'recording'): NormalizedAudio {
  const container = sniffAudioContainer(input);

  if (!container) {
    throw new DoclingError(
      'unsupported_media',
      'Unrecognised audio container. Expected WAV, MP3, M4A/AAC-in-MP4, AAC, OGG or FLAC.',
    );
  }
  if (container.ext === 'webm') {
    throw new DoclingError(
      'unsupported_media',
      'WebM/Matroska is a video container: Docling routes it to the video pipeline, never to ASR. ' +
        'Record audio/mp4 or audio/ogg on the client instead — relabelling the MIME type does not change the bytes.',
    );
  }

  let bytes = input;
  if (container.ext === 'm4a') {
    const brand = String.fromCharCode(...input.subarray(8, 12));
    if (brand !== 'M4A ') {
      bytes = input.slice();
      bytes[8] = 0x4d; // 'M'
      bytes[9] = 0x34; // '4'
      bytes[10] = 0x41; // 'A'
      bytes[11] = 0x20; // ' '
    }
  }

  const base =
    filenameHint.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) ||
    'recording';

  return { bytes, mime: container.mime, ext: container.ext, filename: `${base}.${container.ext}` };
}

// --- submit -----------------------------------------------------------------

/** Uploads the audio and returns the Docling task id. */
export async function submitDoclingJob(audio: NormalizedAudio): Promise<string> {
  const { baseUrl, apiKey } = doclingConfig();

  if (audio.bytes.byteLength > DOCLING_MAX_BYTES) {
    throw new DoclingError(
      'unsupported_media',
      `Audio is ${Math.round(audio.bytes.byteLength / 1e6)} MB; the Docling limit is ${Math.round(DOCLING_MAX_BYTES / 1e6)} MB.`,
    );
  }

  const form = new FormData();
  form.append('files', new Blob([audio.bytes as unknown as BlobPart], { type: audio.mime }), audio.filename);
  form.append('to_formats', 'md');
  form.append('target_type', 'inbody');

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/convert/file/async`, {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey },
      body: form,
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new DoclingError('transient', `Docling submit request failed: ${String(cause)}`, {
      retryable: true,
      cause,
    });
  }

  if (!res.ok) throw httpToDoclingError('submit', res.status, await safeText(res));

  const body = (await res.json()) as { task_id?: string };
  if (!body.task_id) {
    throw new DoclingError('protocol', `Docling submit returned no task_id: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body.task_id;
}

// --- poll -------------------------------------------------------------------

export interface DoclingPoll {
  state: 'pending' | 'succeeded' | 'failed';
  taskStatus: string;
  message: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

const TERMINAL_SUCCESS = new Set(['success', 'partial_success']);
const TERMINAL_FAILURE = new Set(['failure', 'skipped']);

/**
 * Polls a task exactly once. Rate limits and 5xx are reported as `pending` with
 * a retry hint so a transient blip never kills a job that is still running.
 */
export async function pollDoclingTask(taskId: string): Promise<DoclingPoll> {
  const { baseUrl, apiKey } = doclingConfig();

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/status/poll/${encodeURIComponent(taskId)}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  } catch {
    return { state: 'pending', taskStatus: 'network_error', message: null, retryable: true, retryAfterMs: 5000 };
  }

  if (res.status === 429) {
    return {
      state: 'pending',
      taskStatus: 'rate_limited',
      message: null,
      retryable: true,
      retryAfterMs: retryAfterMs(res) ?? 10_000,
    };
  }
  if (res.status >= 500) {
    return { state: 'pending', taskStatus: `http_${res.status}`, message: null, retryable: true, retryAfterMs: 5000 };
  }
  if (res.status === 404) {
    return {
      state: 'failed',
      taskStatus: 'not_found',
      message: `Docling task ${taskId} not found (tasks and results are kept 24 hours).`,
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (!res.ok) throw httpToDoclingError('poll', res.status, await safeText(res), taskId);

  const body = (await res.json()) as {
    task_status?: string;
    error_message?: string | null;
    failure?: { category?: string; message?: string; retryable?: boolean; phase?: string } | null;
  };

  const taskStatus = String(body.task_status ?? '');

  if (TERMINAL_FAILURE.has(taskStatus)) {
    const f = body.failure;
    const detail = [f?.category, f?.message ?? body.error_message, f?.phase ? `phase=${f.phase}` : null]
      .filter(Boolean)
      .join(' · ');
    return {
      state: 'failed',
      taskStatus,
      message: `Docling task ${taskId} ${taskStatus}${detail ? `: ${detail}` : ''}`,
      retryable: f?.retryable === true,
      retryAfterMs: null,
    };
  }

  if (TERMINAL_SUCCESS.has(taskStatus)) {
    return { state: 'succeeded', taskStatus, message: null, retryable: false, retryAfterMs: null };
  }

  // pending | started | processing | anything else the gateway invents
  return { state: 'pending', taskStatus, message: null, retryable: true, retryAfterMs: null };
}

// --- result -----------------------------------------------------------------

interface DoclingResultBody {
  kind?: string;
  failure?: { category?: string; message?: string; retryable?: boolean; phase?: string };
  document?: { md_content?: string | null; text_content?: string | null; filename?: string };
  status?: string;
  errors?: unknown[];
  documents?: Array<{
    filename?: string;
    status?: string;
    errors?: unknown[];
    artifacts?: Array<{ artifact_type?: string; mime_type?: string; uri?: string }>;
  }>;
  num_succeeded?: number;
  num_failed?: number;
}

/**
 * Fetches the transcript. Results are single-use and expire, so the caller MUST
 * persist the returned text in the same request. Handles all three documented
 * response shapes: inbody document, presigned artifacts, and TaskFailureResult.
 */
export async function fetchDoclingResult(taskId: string): Promise<string> {
  const { baseUrl, apiKey } = doclingConfig();

  // Wrapped like submitDoclingJob: a raw TimeoutError or socket failure here
  // would reach the pipeline's catch-all as a non-retryable error and kill a
  // recording whose transcript is sitting on the server, ready to be fetched.
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/result/${encodeURIComponent(taskId)}`, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new DoclingError('transient', `Docling result request failed: ${String(cause)}`, {
      retryable: true,
      taskId,
      cause,
    });
  }

  if (res.status === 404) {
    const text = await safeText(res);
    throw new DoclingError(
      'not_found',
      `Docling result for ${taskId} is gone (single-use, 24h retention): ${text.slice(0, 300)}`,
      { taskId, httpStatus: 404 },
    );
  }
  if (!res.ok) throw httpToDoclingError('result', res.status, await safeText(res), taskId);

  const body = (await res.json()) as DoclingResultBody;

  if (body.kind === 'TaskFailureResult' || (body.failure && !body.document && !body.documents)) {
    const f = body.failure;
    throw new DoclingError(
      'task_failed',
      `Docling task ${taskId} failed: ${[f?.category, f?.message, f?.phase].filter(Boolean).join(' · ') || 'unknown'}`,
      { taskId, retryable: f?.retryable === true },
    );
  }

  let text = '';

  if (body.document) {
    text = (body.document.md_content ?? body.document.text_content ?? '').trim();
  }

  if (!text && body.documents?.length) {
    const doc = body.documents[0];
    const artifact =
      doc.artifacts?.find((a) => a.artifact_type === 'markdown') ??
      doc.artifacts?.find((a) => a.mime_type === 'text/markdown') ??
      doc.artifacts?.[0];
    if (artifact?.uri) {
      text = (await fetchArtifact(artifact.uri, apiKey)).trim();
    }
  }

  if (!text) throw classifyEmptyResult(taskId, body);
  return text;
}

async function fetchArtifact(uri: string, apiKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(uri, { signal: AbortSignal.timeout(RESULT_TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) {
      res = await fetch(uri, { headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(RESULT_TIMEOUT_MS) });
    }
  } catch (cause) {
    throw new DoclingError('transient', `Fetching the Docling result artifact failed: ${String(cause)}`, {
      retryable: true,
      cause,
    });
  }
  if (!res.ok) {
    throw new DoclingError('transient', `Fetching the Docling result artifact failed: ${res.status}`, {
      retryable: res.status >= 500,
      httpStatus: res.status,
    });
  }
  return res.text();
}

/**
 * An empty transcript on a "successful" task is never OK. Distinguishes a
 * server-side ASR deployment gap (no ffmpeg / no Whisper) from silence, so the
 * user gets a message that names the real problem.
 */
function classifyEmptyResult(taskId: string, body: DoclingResultBody): DoclingError {
  const blob = JSON.stringify(body).slice(0, 4000);
  const status = body.status ?? body.documents?.[0]?.status ?? 'unknown';
  const errors = JSON.stringify(body.errors ?? body.documents?.[0]?.errors ?? []).slice(0, 800);

  if (/ffmpeg|whisper|asr|transcrib/i.test(blob)) {
    return new DoclingError(
      'asr_unavailable',
      `Docling task ${taskId} returned no transcript and reported an ASR/ffmpeg problem. ` +
        `This Docling deployment cannot transcribe audio — no client flag can fix it. status=${status} errors=${errors}`,
      { taskId },
    );
  }

  return new DoclingError(
    'empty_transcript',
    `Docling task ${taskId} produced an empty transcript. status=${status} ` +
      `num_succeeded=${body.num_succeeded ?? '?'} num_failed=${body.num_failed ?? '?'} errors=${errors}`,
    { taskId },
  );
}

// --- helpers ----------------------------------------------------------------

function httpToDoclingError(phase: string, status: number, body: string, taskId?: string): DoclingError {
  const snippet = body.slice(0, 600);
  if (status === 429) {
    return new DoclingError('rate_limited', `Docling ${phase} rate limited (429): ${snippet}`, {
      retryable: true, httpStatus: status, taskId,
    });
  }
  if (status === 413 || status === 415) {
    return new DoclingError('unsupported_media', `Docling ${phase} rejected the payload (${status}): ${snippet}`, {
      httpStatus: status, taskId,
    });
  }
  if (status >= 500) {
    return new DoclingError('transient', `Docling ${phase} server error (${status}): ${snippet}`, {
      retryable: true, httpStatus: status, taskId,
    });
  }
  return new DoclingError('protocol', `Docling ${phase} failed (${status}): ${snippet}`, {
    httpStatus: status, taskId,
  });
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
