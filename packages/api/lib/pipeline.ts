/**
 * pipeline.ts
 *
 * Orchestrates the full write-path enrichment pipeline:
 *   1. Transcribe audio via Docling SaaS
 *   2. Enrich transcript via LLM (summary, takeaways, actions, title)
 *   3. Patch Astra DB doc with results + set $vectorize for auto-embedding
 *
 * Uses ora for terminal spinner feedback when running locally.
 * Called fire-and-forget after the upload endpoint returns to the client.
 */

import ora from 'ora';
import { transcribeAudio } from './transcribe';
import { enrichTranscript } from './enrich';
import { storeEnrichment, storeError } from './store';

export async function enrichRecording(id: string, audioUrl: string): Promise<void> {
  const spinner = ora({ text: `[${id}] Transcribing…`, isEnabled: process.env.NODE_ENV !== 'production' }).start();

  try {
    spinner.text = `[${id}] Transcribing audio…`;
    const { srt } = await transcribeAudio(audioUrl);

    spinner.text = `[${id}] Enriching transcript with LLM…`;
    const enrichment = await enrichTranscript(srt);

    spinner.text = `[${id}] Storing results…`;
    await storeEnrichment(id, srt, enrichment);

    spinner.succeed(`[${id}] Enrichment complete — "${enrichment.title}"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(`[${id}] Enrichment failed: ${message}`);
    await storeError(id, message).catch(() => {
      // best-effort — don't let a store error mask the original
    });
  }
}
