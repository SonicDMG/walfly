/**
 * store.ts
 *
 * Patches an existing Recording document in Astra DB after enrichment completes.
 * Sets $vectorize to the transcript text so Astra auto-embeds it.
 */

import { getRecordingsCollection } from '@walfly/db';
import type { EnrichResult } from './enrich';

export async function storeEnrichment(
  id: string,
  transcript: string,
  enrichment: EnrichResult,
): Promise<void> {
  const collection = getRecordingsCollection();

  await collection.updateOne(
    { _id: id },
    {
      $set: {
        transcript,
        summary: enrichment.summary,
        keyTakeaways: enrichment.keyTakeaways,
        actionItems: enrichment.actionItems,
        title: enrichment.title,
        status: 'ready',
        // $vectorize tells Astra to auto-embed this text field
        $vectorize: transcript,
      },
    },
  );
}

export async function storeError(id: string, errorMessage: string): Promise<void> {
  const collection = getRecordingsCollection();

  await collection.updateOne(
    { _id: id },
    {
      $set: {
        status: 'error',
        notes: `Processing error: ${errorMessage}`,
      },
    },
  );
}
