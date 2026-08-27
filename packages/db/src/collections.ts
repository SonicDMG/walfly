/**
 * collections.ts
 *
 * Typed accessor for the `recordings` collection. The collection name lives in
 * constants.ts so the seeder and the capability probe can never drift from the
 * collection the app actually reads.
 */

import type { Collection } from '@datastax/astra-db-ts';
import { getDb } from './client';
import { RECORDINGS_COLLECTION } from './constants';
import type { Recording } from './types';

export function getRecordingsCollection(): Collection<Recording> {
  return getDb().collection<Recording>(RECORDINGS_COLLECTION);
}
