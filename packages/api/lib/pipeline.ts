/**
 * pipeline.ts
 *
 * Orchestrates the full write-path enrichment pipeline:
 *   1. Transcribe audio via Docling SaaS
 *   2. Enrich transcript via LLM (summary, takeaways, actions, title)
 *   3. Patch Astra DB doc with results + set $vectorize for auto-embedding
 *
 * Called fire-and-forget after the upload endpoint returns to the client.
 */

import { transcribeAudio } from './transcribe';
import { enrichTranscript } from './enrich';
import { storeEnrichment, storeError } from './store';

export async function enrichRecording(id: string, audioUrl: string): Promise<void> {
  try {
    const { srt } = await transcribeAudio(audioUrl);
    const enrichment = await enrichTranscript(srt);
    await storeEnrichment(id, srt, enrichment);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[enrichRecording] Failed for recording ${id}:`, message);
    await storeError(id, message).catch(() => {
      // best-effort — don't let a store error mask the original
    });
  }
}
