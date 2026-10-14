import { DoclingError, normalizeAudioForAsr } from '@/lib/docling';
import { recoverPathname } from '@/lib/recoverPolicy';
import { storageMode, storeAudio } from '@/lib/storage';
import { maxUploadBytes } from '@/lib/uploadLimits';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * POST /api/recordings/{id}/recover/audio  (local storage mode only)
 *
 * Whole-file upload of the client's local buffer when no Blob store is
 * configured. Stores the bytes under the deterministic recovery pathname but
 * does not attach — one attach path exists in both modes (`/recover/complete`).
 * A local Next.js server has no request-body cap; the 100 MB guard applies.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (storageMode() !== 'local') {
    return NextResponse.json(
      { error: 'Blob storage mode — upload via /recover/upload', code: 'blob_mode' },
      { status: 409 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }
  const file = form.get('audio');
  if (!(file instanceof Blob) || file.size === 0) {
    return NextResponse.json({ error: 'Missing `audio` file' }, { status: 400 });
  }

  const durationRaw = Number(form.get('duration'));
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > maxUploadBytes()) {
      return NextResponse.json(
        {
          error: `Recovered audio is ${(bytes.byteLength / 1e6).toFixed(1)} MB, over the ${(maxUploadBytes() / 1e6).toFixed(0)} MB local limit.`,
          code: 'too_large',
        },
        { status: 413 },
      );
    }

    let normalized;
    try {
      normalized = normalizeAudioForAsr(bytes, (file as File).name || `${id}.wav`);
    } catch (err) {
      if (err instanceof DoclingError && err.code === 'unsupported_media') {
        return NextResponse.json({ error: err.message, code: 'unsupported_media' }, { status: 415 });
      }
      throw err;
    }

    const key = recoverPathname(id, normalized.ext);
    const stored = await storeAudio(key, normalized.bytes, normalized.mime);
    return NextResponse.json(
      { pathname: key, url: stored.url, bytes: stored.bytes, contentType: stored.contentType, duration },
      { status: 201 },
    );
  } catch (error) {
    console.error('[Recover Audio API] Error storing recovered audio:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
