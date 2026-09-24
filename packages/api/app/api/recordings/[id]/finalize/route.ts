import { finalizeLiveSession } from '@/lib/store';
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

    return NextResponse.json({ id, status: 'uploaded' }, { status: 200 });
  } catch (error) {
    console.error(`[Finalize API] Error finalizing session:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
