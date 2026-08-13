import { getDb } from './client';
import type { Recording } from './types';

const COLLECTION_NAME = 'recordings';

/** Returns the Astra DB recordings collection handle. */
export function getRecordingsCollection() {
  return getDb().collection<Recording>(COLLECTION_NAME);
}
