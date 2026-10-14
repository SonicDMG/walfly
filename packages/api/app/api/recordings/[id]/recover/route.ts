import { getRecoverState } from '@/lib/recover';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * GET /api/recordings/{id}/recover?bytes=<n>&ext=<wav>
 *
 * The recovery handshake: does this recording still need the audio sitting in
 * the client's local buffer? Never mutates, so it is safe on every launch and
 * every retry. `bytes` lets the server pre-answer "is my object already there".
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || id.length > 200) {
    return NextResponse.json({ error: 'Invalid recording id' }, { status: 400 });
  }

  const bytesRaw = req.nextUrl.searchParams.get('bytes');
  const bytes = bytesRaw !== null && /^\d+$/.test(bytesRaw) ? Number(bytesRaw) : null;
  const ext = req.nextUrl.searchParams.get('ext');

  try {
    const state = await getRecoverState(id, { bytes, ext });
    return NextResponse.json(state);
  } catch (error) {
    console.error('[Recover API] Error reading recovery state:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
