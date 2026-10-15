import { isRecoverPathnameFor, type RecoverPreference } from '@/lib/recoverPolicy';
import { deleteStoredAudio } from '@/lib/storage';
import { attachRecoveredAudio } from '@/lib/store';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const MAX_DURATION_SEC = 4 * 3600;

/**
 * POST /api/recordings/{id}/recover/complete
 *
 * Verifies the uploaded object, attaches it to the recording (creating the doc
 * when the crash happened before the session was ever registered), and decides
 * whether the durable transcript stays the sidecar's streamed copy or is
 * re-transcribed from the complete file. Idempotent by construction: the
 * object pathname is deterministic and the attach is a compare-and-set.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const pathname = typeof body.pathname === 'string' ? body.pathname : '';
  const bytes = Number(body.bytes);
  const durationSec = Number(body.duration);
  const gapMs = typeof body.gapMs === 'number' && Number.isFinite(body.gapMs) && body.gapMs >= 0
    ? Math.round(body.gapMs)
    : null;
  const prefer: RecoverPreference =
    body.prefer === 'stream' || body.prefer === 'batch' ? body.prefer : 'auto';

  if (!isRecoverPathnameFor(id, pathname)) {
    return NextResponse.json({ error: 'pathname does not belong to this recording' }, { status: 400 });
  }
  if (!Number.isInteger(bytes) || bytes <= 0) {
    return NextResponse.json({ error: '`bytes` must be a positive integer' }, { status: 400 });
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > MAX_DURATION_SEC) {
    return NextResponse.json(
      { error: `\`duration\` must be between 0 and ${MAX_DURATION_SEC} seconds` },
      { status: 400 },
    );
  }
  const createdAt = typeof body.createdAt === 'string' ? body.createdAt : undefined;
  const lat = typeof body.lat === 'number' && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === 'number' && Number.isFinite(body.lng) ? body.lng : null;
  const placeName = typeof body.placeName === 'string' ? body.placeName : null;
  const clientAttempts = Number.isInteger(body.clientAttempts) ? body.clientAttempts : undefined;

  try {
    const attached = await attachRecoveredAudio({
      recordingId: id,
      pathname,
      bytes,
      durationSec,
      gapMs,
      prefer,
      createdAt,
      lat,
      lng,
      placeName,
      clientAttempts,
    });

    switch (attached.result) {
      case 'object_missing':
        return NextResponse.json(
          { error: 'Recovered audio object not found — re-run the upload', code: 'object_missing', expected: attached.expected },
          { status: 409 },
        );
      case 'size_mismatch':
        return NextResponse.json(
          { error: 'Stored object size differs from the delivery', code: 'size_mismatch', expected: attached.expected, actual: attached.actual },
          { status: 409 },
        );
      case 'audio_conflict': {
        // Another delivery won with a different object; our offer is residue.
        await deleteStoredAudio(pathname).catch((err) =>
          console.warn('[Recover Complete API] Failed to delete losing object:', err),
        );
        return NextResponse.json(
          { error: 'Audio already attached from a different delivery', code: 'audio_conflict', audioUrl: attached.audioUrl },
          { status: 409 },
        );
      }
      default: {
        return NextResponse.json({
          id,
          status: attached.status,
          stage: attached.transcriptSource === 'stream' ? 'enrich' : 'transcribe',
          transcriptSource: attached.transcriptSource,
          error: null,
          retryAfterMs: 0,
          audioUrl: attached.audioUrl,
          recovered: true,
          alreadyAttached: attached.result === 'alreadyAttached',
        });
      }
    }
  } catch (error) {
    console.error('[Recover Complete API] Error attaching recovered audio:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
