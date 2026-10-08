import { detectMusicFromChunks, flushMusicBuffer } from '@/lib/music';
import { finalizeLiveSession, storeMusicDetection } from '@/lib/store';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));

    await finalizeLiveSession(
      id,
      typeof body.totalExpectedChunks === 'number' ? body.totalExpectedChunks : undefined,
      typeof body.duration === 'number' ? body.duration : undefined,
    );

    // Flush any leftover accumulated chunks (fewer than 4 when the session
    // ended early). In `next dev` the module-level buffer persists; in
    // cold-start serverless there are none to flush.
    const leftovers = flushMusicBuffer(id);
    if (leftovers.length > 0) {
      void detectMusicFromChunks(leftovers).then((result) => {
        if (result.detected) {
          void storeMusicDetection(id, result).catch((e) =>
            console.warn('[Finalize API] Failed to store music detection:', e),
          );
        }
      }).catch(() => { /* already non-throwing */ });
    }

    return NextResponse.json({ id, status: 'uploaded' }, { status: 200 });
  } catch (error) {
    console.error(`[Finalize API] Error finalizing session:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
