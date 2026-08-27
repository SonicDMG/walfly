/**
 * /api/recordings/upload
 *
 * GET  — reports the upload limits and accepted MIME types to the client.
 * POST — multipart/form-data: stores the audio and inserts the Recording
 *        document with status "uploaded".
 *
 * The bytes are authoritative. The client's filename and declared MIME type are
 * only diagnostics: the container is identified from magic bytes here, because
 * relabelling a Blob transcodes nothing and a WebM upload can never reach
 * Docling's ASR pipeline no matter what it claims to be.
 *
 * This route deliberately starts NO work. There is no detached promise and no
 * after() anywhere in this codebase — the client drives the pipeline by POSTing
 * /api/recordings/{id}/process, so every unit of work is a short, fully awaited
 * request that behaves identically in `next dev` and on Vercel.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  ACCEPTED_UPLOAD_MIME_TYPES,
  DoclingError,
  normalizeAudioForAsr,
  sniffAudioContainer,
  type NormalizedAudio,
} from '@/lib/docling';
import { deleteAudio, storageMode, storeAudio } from '@/lib/storage';
import { createRecording } from '@/lib/store';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Vercel rejects a larger request body at the routing layer, before this
 * handler runs, with an HTML 413. That is a platform limit on the request — not
 * a storage limit — so it applies whenever we are deployed there, regardless of
 * where the bytes end up. A local server has no such cap, and needs the
 * headroom: browsers that can only record WebM upload 16 kHz mono WAV instead,
 * which is uncompressed at ~32 KB/s against Opus's ~4 KB/s.
 */
function maxUploadBytes(): number {
  return process.env.VERCEL ? 4_000_000 : 100_000_000;
}

interface UploadCapabilities {
  maxUploadBytes: number;
  storage: 'blob' | 'local';
  acceptedMimeTypes: string[];
}

interface UploadResponse {
  id: string;
  status: 'uploaded';
  audioUrl: string;
  audioContentType: string;
}

interface ApiError {
  error: string;
  code?: string;
}

export async function GET(): Promise<NextResponse<UploadCapabilities>> {
  return NextResponse.json({
    maxUploadBytes: maxUploadBytes(),
    storage: storageMode(),
    acceptedMimeTypes: ACCEPTED_UPLOAD_MIME_TYPES,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse<UploadResponse | ApiError>> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error('[upload] Failed to parse multipart/form-data:', err);
    return NextResponse.json({ error: 'Invalid multipart/form-data' }, { status: 400 });
  }

  const audioFile = formData.get('audio');
  if (!audioFile || !(audioFile instanceof Blob)) {
    return NextResponse.json({ error: 'Missing audio field' }, { status: 400 });
  }

  const declaredMime = String(formData.get('audioMimeType') ?? '') || (audioFile as File).type || '';
  const uploadedName = (audioFile as File).name || 'recording';

  const bytes = new Uint8Array(await audioFile.arrayBuffer());

  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: 'The uploaded audio is empty' }, { status: 400 });
  }
  const limit = maxUploadBytes();
  if (bytes.byteLength > limit) {
    // Returned explicitly so the client never has to parse Vercel's HTML 413.
    return NextResponse.json(
      {
        error: `Audio exceeds the ${(limit / 1e6).toFixed(1)} MB upload limit (${(
          bytes.byteLength / 1e6
        ).toFixed(1)} MB). Record a shorter walk.`,
        code: 'payload_too_large',
      },
      { status: 413 },
    );
  }

  const container = sniffAudioContainer(bytes);
  console.log(
    `[upload] declared=${declaredMime || 'none'} sniffed=${container?.mime ?? 'unknown'} bytes=${bytes.byteLength}`,
  );

  let normalized: NormalizedAudio;
  try {
    normalized = normalizeAudioForAsr(bytes, uploadedName);
  } catch (err) {
    if (err instanceof DoclingError && err.code === 'unsupported_media') {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 415 });
    }
    console.error('[upload] Audio validation failed:', err);
    return NextResponse.json({ error: 'Could not validate the uploaded audio' }, { status: 500 });
  }

  const duration = Math.max(0, Math.round(Number(formData.get('duration') ?? '0')) || 0);
  const clientTimestamp = readIsoTimestamp(formData.get('clientTimestamp'));
  const lat = readCoordinate(formData.get('lat'));
  const lng = readCoordinate(formData.get('lng'));
  const placeNameRaw = formData.get('placeName');
  const placeName = typeof placeNameRaw === 'string' && placeNameRaw.trim() ? placeNameRaw.trim() : null;

  const id = crypto.randomUUID();

  let stored: Awaited<ReturnType<typeof storeAudio>>;
  try {
    stored = await storeAudio(`recordings/${id}.${normalized.ext}`, normalized.bytes, normalized.mime);
  } catch (err) {
    console.error('[upload] Audio storage failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Audio storage failed' },
      { status: 500 },
    );
  }

  try {
    await createRecording({
      id,
      createdAt: clientTimestamp,
      duration,
      audioUrl: stored.url,
      audioContentType: stored.contentType,
      lat,
      lng,
      placeName,
    });
  } catch (err) {
    console.error('[upload] Astra DB insert failed:', err);
    // The bytes are already stored but nothing references them, and DELETE
    // /api/recordings/{id} — the only other caller of deleteAudio — needs a
    // document that was never created. In Blob mode this would otherwise be a
    // billed object no code path can ever remove.
    await deleteAudio(stored.url).catch((cleanupErr: unknown) => {
      console.warn(`[upload] could not remove the orphaned audio at ${stored.url}:`, cleanupErr);
    });
    return NextResponse.json(
      { error: err instanceof Error ? `Database insert failed: ${err.message}` : 'Database insert failed' },
      { status: 500 },
    );
  }

  console.log(`[upload] ${id} stored ${normalized.ext} (${stored.bytes} bytes) at ${stored.url}`);

  return NextResponse.json(
    { id, status: 'uploaded', audioUrl: stored.url, audioContentType: stored.contentType },
    { status: 201 },
  );
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

/** Falls back to server time when the client sends nothing usable. */
function readIsoTimestamp(value: FormDataEntryValue | null): string {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function readCoordinate(value: FormDataEntryValue | null): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
