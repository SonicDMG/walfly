/**
 * transcribe.ts
 *
 * Provider-facing seam for speech-to-text. Today there is exactly one provider,
 * Docling SaaS in the cloud; the three exported functions are deliberately
 * submit / poll / fetch so the caller can run each as its own short, awaited
 * step of the resumable pipeline instead of blocking a function for minutes.
 *
 * Docling's ASR pipeline emits paragraph-level markdown with "[time: a-b]"
 * prefixes — not SRT. The field is named `markdown` everywhere.
 */

import {
  DoclingError,
  fetchDoclingResult,
  isDoclingConfigured,
  normalizeAudioForAsr,
  pollDoclingTask,
  submitDoclingJob,
  type DoclingPoll,
} from './docling';
import { loadAudio } from './storage';

export type TranscriptionPoll = DoclingPoll;
export { DoclingError as TranscriptionError };

export function isTranscriptionConfigured(): boolean {
  return isDoclingConfigured();
}

/** Loads the stored audio, normalises the container, and submits it. Returns the task id. */
export async function submitTranscriptionJob(audioUrl: string): Promise<string> {
  const { bytes } = await loadAudio(audioUrl);
  const normalized = normalizeAudioForAsr(bytes, 'recording');
  return submitDoclingJob(normalized);
}

/** One non-blocking status check. Never throws for transient conditions. */
export async function pollTranscriptionJob(taskId: string): Promise<TranscriptionPoll> {
  return pollDoclingTask(taskId);
}

/**
 * Fetches the transcript markdown. Single-use: the caller must persist the
 * result before returning from the same request.
 */
export async function fetchTranscriptionResult(taskId: string): Promise<string> {
  return fetchDoclingResult(taskId);
}
