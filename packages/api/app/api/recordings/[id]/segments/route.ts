import { getRecordingsV2Collection } from '@walfly/db';
import { recordSegmentTranscript } from '@/lib/store';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Segments are short utterances; this is a sanity bound, not a format rule. */
const MAX_SEGMENT_TEXT_CHARS = 8000;

/**
 * POST /api/recordings/{id}/segments
 *
 * The client's checkpoint: one finalized streaming segment from the sidecar's
 * `segment` event, posted before the client ACKs it. The write is idempotent
 * (segment docs are keyed by recording + chunkIndex) and the parent transcript
 * is appended in order or rebuilt on any index mismatch, so retries and
 * replays are safe.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: recordingId } = await params;
    const body = await req.json().catch(() => null);

    const chunkIndex = Number(body?.chunkIndex);
    const startMs = Number(body?.startMs);
    const endMs = Number(body?.endMs);
    const text = typeof body?.text === 'string' ? body.text : '';

    if (
      !Number.isInteger(chunkIndex) || chunkIndex < 0 ||
      !Number.isFinite(startMs) || startMs < 0 ||
      !Number.isFinite(endMs) || endMs < startMs ||
      !text.trim()
    ) {
      return NextResponse.json(
        { error: 'Expected { chunkIndex, startMs, endMs, text }' },
        { status: 400 },
      );
    }
    if (text.length > MAX_SEGMENT_TEXT_CHARS) {
      return NextResponse.json(
        { error: `Segment text exceeds ${MAX_SEGMENT_TEXT_CHARS} characters` },
        { status: 400 },
      );
    }

    const collection = getRecordingsV2Collection();
    const recording = await collection.findOne(
      { _id: recordingId },
      { projection: { _id: 1, isLiveSession: 1, status: 1 } },
    );
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }
    if (!recording.isLiveSession) {
      return NextResponse.json(
        { error: 'Segments are only accepted for live sessions' },
        { status: 409 },
      );
    }
    // `recording` while streaming, `uploaded` for the in-flight tail that
    // arrives after the client calls finalize. Anything later is a stale retry.
    if (recording.status !== 'recording' && recording.status !== 'uploaded') {
      return NextResponse.json(
        { error: `Recording is ${recording.status}; no longer accepting segments` },
        { status: 409 },
      );
    }

    const { receivedChunks } = await recordSegmentTranscript({
      recordingId,
      chunkIndex,
      startMs,
      endMs,
      text,
    });

    return NextResponse.json({ ok: true, chunkIndex, receivedChunks }, { status: 200 });
  } catch (error) {
    console.error('[Segments API] Error recording segment:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
