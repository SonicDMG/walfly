import { getRecordingsV2Collection } from '@walfly/db';
import { mintWsTicket } from '@/lib/wsTicket';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * POST /api/recordings/{id}/ws-ticket
 *
 * Mints a two-minute, single-use ticket for opening the audio WebSocket to the
 * ASR sidecar. The client calls this right before connecting; reconnects ask
 * for a fresh one.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const collection = getRecordingsV2Collection();
    const recording = await collection.findOne(
      { _id: id },
      { projection: { _id: 1, isLiveSession: 1, status: 1 } },
    );

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }
    if (!recording.isLiveSession) {
      return NextResponse.json(
        { error: 'Streaming tickets are only issued for live sessions' },
        { status: 409 },
      );
    }

    const ticket = mintWsTicket(id);
    return NextResponse.json(ticket, { status: 201 });
  } catch (error) {
    console.error('[WS Ticket API] Error minting ticket:', error);
    const message = error instanceof Error ? error.message : 'Internal Server Error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
