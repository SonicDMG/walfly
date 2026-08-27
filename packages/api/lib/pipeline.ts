/**
 * pipeline.ts
 *
 * One tick of the resumable recording pipeline. Each call advances the job by
 * at most one step and returns, so no invocation ever outlives a serverless
 * function's budget and `next dev` behaves identically to Vercel. Every long
 * step is guarded by an expiring lease held in Astra, which is what makes a
 * mid-step crash recoverable: the lease simply expires and the next tick
 * resumes from the last durable state.
 *
 * Failure handling has two tiers, because "the Blob CDN returned one 500" and
 * "this audio is not a format Docling can read" are not the same event. A
 * retryable error frees the lease, bumps an attempt counter and leaves the
 * status alone so the next tick retries; only a non-retryable error, or one
 * that has already burned MAX_TRANSIENT_ATTEMPTS, is written as a terminal
 * failure. Nothing here ever throws — the caller is an HTTP route that must
 * answer 200 or 404.
 *
 * Lease durations are deliberately longer than the worst-case wall time of the
 * work they guard (see the constants), otherwise a slow step would be re-leased
 * and run twice concurrently.
 *
 * There is deliberately no background work, no detached promise, and no
 * after()/waitUntil anywhere in this codebase.
 */

import type { PipelineStage, RecordingStatus } from '@walfly/db';
import { DoclingError } from './docling';
import { enrichTranscript } from './enrich';
import {
  acquireLease, getPipelineRecord, recordTransientFailure, releaseLease, storeDoclingTaskId,
  storeEnrichment, storeFailure, storeTranscript,
} from './store';
import { fetchTranscriptionResult, pollTranscriptionJob, submitTranscriptionJob } from './transcribe';

/** Worst case: loadAudio (60 s) + the Docling submit (120 s), plus slack. */
const LEASE_SUBMIT_MS = 240_000;
/** Worst case: poll (20 s) + single-use result fetch (60 s) + the Astra write. */
const LEASE_TRANSCRIBE_MS = 120_000;
/** Worst case: two LLM attempts at 60 s each (llm.ts sets maxRetries: 0), plus slack. */
const LEASE_ENRICH_MS = 240_000;

/** A Docling job that has not finished in this long is treated as lost. */
const TRANSCRIBE_DEADLINE_MS = 20 * 60 * 1000;

/** Consecutive retryable failures on one step before the job is declared dead. */
const MAX_TRANSIENT_ATTEMPTS = 5;

export interface AdvanceResult {
  found: boolean;
  id: string;
  status: RecordingStatus | null;
  stage: PipelineStage;
  error: string | null;
  retryAfterMs: number;
}

export async function advanceRecording(id: string): Promise<AdvanceResult> {
  let stage: PipelineStage = 'submit';
  let status: RecordingStatus | null = null;
  let attempts = 0;

  try {
    // Inside the try: a Data API blip on this read is a transient condition, not
    // a reason to answer with an unhandled 500 or to kill the recording.
    const record = await getPipelineRecord(id);
    if (!record) return { found: false, id, status: null, stage: 'done', error: null, retryAfterMs: 0 };

    status = record.status;
    attempts = record.attempts;

    if (record.status === 'ready' || record.status === 'failed') {
      return { found: true, id, status: record.status, stage: 'done', error: null, retryAfterMs: 0 };
    }

    // ---- uploaded → submit the Docling job -------------------------------
    if (record.status === 'uploaded') {
      stage = 'submit';
      if (!(await acquireLease(id, 'uploaded', LEASE_SUBMIT_MS))) {
        return waiting(id, 'uploaded', 'submit', 2000);
      }
      const taskId = await submitTranscriptionJob(record.audioUrl);
      await storeDoclingTaskId(id, taskId);
      console.log(`[pipeline] ${id} submitted docling task ${taskId}`);
      return { found: true, id, status: 'transcribing', stage: 'transcribe', error: null, retryAfterMs: 4000 };
    }

    // ---- transcribing ----------------------------------------------------
    if (record.status === 'transcribing') {
      stage = 'transcribe';

      // The submit step crashed before the task id was persisted. Resubmit
      // once the lease has expired.
      if (!record.doclingTaskId) {
        if (!(await acquireLease(id, 'transcribing', LEASE_SUBMIT_MS))) {
          return waiting(id, 'transcribing', 'transcribe', 3000);
        }
        const taskId = await submitTranscriptionJob(record.audioUrl);
        await storeDoclingTaskId(id, taskId);
        return { found: true, id, status: 'transcribing', stage: 'transcribe', error: null, retryAfterMs: 4000 };
      }

      if (record.submittedAt && Date.now() - record.submittedAt > TRANSCRIBE_DEADLINE_MS) {
        throw new Error(
          `Docling task ${record.doclingTaskId} did not finish within ${Math.round(TRANSCRIBE_DEADLINE_MS / 60000)} minutes.`,
        );
      }

      // The result endpoint is single-use, so the whole branch is leased.
      if (!(await acquireLease(id, 'transcribing', LEASE_TRANSCRIBE_MS))) {
        return waiting(id, 'transcribing', 'transcribe', 3000);
      }

      const poll = await pollTranscriptionJob(record.doclingTaskId);

      if (poll.state === 'pending') {
        await releaseLease(id);
        return {
          found: true, id, status: 'transcribing', stage: 'transcribe', error: null,
          retryAfterMs: poll.retryAfterMs ?? 4000,
        };
      }

      if (poll.state === 'failed') {
        throw new DoclingError('task_failed', poll.message ?? 'Docling transcription failed', {
          retryable: poll.retryable,
          taskId: record.doclingTaskId,
        });
      }

      // Succeeded: fetch once and persist in the same request.
      const markdown = await fetchTranscriptionResult(record.doclingTaskId);
      await storeTranscript(id, markdown);
      console.log(`[pipeline] ${id} transcript stored (${markdown.length} chars)`);
      return { found: true, id, status: 'enriching', stage: 'enrich', error: null, retryAfterMs: 1000 };
    }

    // ---- enriching -------------------------------------------------------
    if (record.status === 'enriching') {
      stage = 'enrich';
      if (!record.transcript) throw new Error('Reached the enrichment step with no stored transcript');
      if (!(await acquireLease(id, 'enriching', LEASE_ENRICH_MS))) {
        return waiting(id, 'enriching', 'enrich', 5000);
      }
      const enrichment = await enrichTranscript(record.transcript);
      await storeEnrichment(id, record.transcript, enrichment);
      console.log(`[pipeline] ${id} ready — "${enrichment.title}"`);
      return { found: true, id, status: 'ready', stage: 'done', error: null, retryAfterMs: 0 };
    }

    // An unrecognised status. Documents written before the pipeline was
    // rewritten carry the retired values "processing" and "error", and there is
    // no safe way to resume one: the Docling task id was never persisted. Report
    // it as terminal with retryAfterMs 0 so clients stop ticking it forever —
    // returning `waiting` here would poll a dead document on every list refresh.
    console.warn(`[pipeline] ${id} has unrecognised status "${record.status}" — treating as terminal`);
    return { found: true, id, status: record.status, stage: 'done', error: null, retryAfterMs: 0 };
  } catch (err) {
    return handleFailure(id, stage, status, attempts, err);
  }
}

/**
 * Routes a thrown error to either a retry or a terminal failure. Every write
 * here is itself wrapped, because the reason we are in this branch is often
 * that Astra is unreachable.
 */
async function handleFailure(
  id: string,
  stage: PipelineStage,
  status: RecordingStatus | null,
  attempts: number,
  err: unknown,
): Promise<AdvanceResult> {
  const message = describe(err);
  const nextAttempt = attempts + 1;

  if (status === null) {
    // The very first read failed, so we do not know this recording's state and
    // must not write one. The route turns this into a 503 carrying `message`;
    // the document is untouched and the next tick resumes from wherever it was.
    console.error(`[pipeline] ${id} could not read its state: ${message}`);
    return { found: true, id, status: null, stage, error: message, retryAfterMs: 3000 };
  }

  if (isRetryable(err) && nextAttempt < MAX_TRANSIENT_ATTEMPTS) {
    console.warn(`[pipeline] ${id} transient failure at ${stage} (attempt ${nextAttempt}): ${message}`);
    // Both writes are best effort: if Astra is the thing that is down, the
    // expiring lease alone still lets the next tick resume.
    await recordTransientFailure(id, stage, message).catch((writeErr) => {
      console.error(`[pipeline] ${id} could not record the transient failure:`, writeErr);
    });
    return {
      found: true,
      id,
      status,
      stage,
      // Carried so the route (and the client) can name the real cause even
      // though the recording is still alive and will be retried.
      error: message,
      retryAfterMs: Math.min(2000 * 2 ** attempts, 30_000),
    };
  }

  console.error(`[pipeline] ${id} failed at ${stage}: ${message}`);
  await storeFailure(id, stage, message).catch((storeErr) => {
    console.error(`[pipeline] ${id} could not record the failure:`, storeErr);
  });
  return { found: true, id, status: 'failed', stage, error: message, retryAfterMs: 0 };
}

/**
 * Whether the job is worth another tick. Docling classifies its own errors; on
 * top of that, anything that looks like a timed-out or refused network call is
 * retryable, because the audio and the Docling task both still exist.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof DoclingError) return err.retryable;
  if (!(err instanceof Error)) return false;

  // AbortSignal.timeout, undici socket errors, and the Astra driver's own
  // timeout/http wrappers all surface as one of these.
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError') return true;
  if (/DataAPITimeoutError|DataAPIHttpError|FetchError|ConnectTimeout|TransientStorageError/.test(err.name)) {
    return true;
  }

  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN';
}

function waiting(id: string, status: RecordingStatus, stage: PipelineStage, retryAfterMs: number): AdvanceResult {
  return { found: true, id, status, stage, error: null, retryAfterMs };
}

/** Keeps the provider's own diagnostics — the reason a job failed is almost always in them. */
function describe(err: unknown): string {
  if (err instanceof DoclingError) return `[${err.code}] ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
