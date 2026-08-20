/**
 * storage.ts
 *
 * Abstraction over audio file storage.
 *
 * - BLOB_READ_WRITE_TOKEN set → Vercel Blob (production)
 * - BLOB_READ_WRITE_TOKEN unset/empty → local OS temp dir (development)
 *
 * Both paths return a public URL string that is stored on the Recording doc.
 * The local URL uses the /api/recordings/audio/:filename serve route.
 */

import { put } from '@vercel/blob';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export async function storeAudio(filename: string, file: Blob): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('[storage] Using Vercel Blob');
    const blob = await put(filename, file, { access: 'public' });
    return blob.url;
  }

  // Local fallback — write to OS tmpdir and return a local API URL
  console.log('[storage] BLOB_READ_WRITE_TOKEN not set — writing to tmpdir');
  const buffer = Buffer.from(await file.arrayBuffer());
  const basename = filename.replace(/\//g, '_');
  const dest = join(tmpdir(), basename);
  await writeFile(dest, buffer);
  const audioFilename = encodeURIComponent(basename);
  console.log(`[storage] Saved to ${dest}`);
  return `/api/recordings/audio/${audioFilename}`;
}
