import { createLiveSession } from '@/lib/store';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = body.id || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()));
    const createdAt = body.createdAt || new Date().toISOString();

    await createLiveSession({
      id,
      createdAt,
      lat: typeof body.lat === 'number' ? body.lat : null,
      lng: typeof body.lng === 'number' ? body.lng : null,
      placeName: typeof body.placeName === 'string' ? body.placeName : null,
      title: typeof body.title === 'string' ? body.title : undefined,
    });

    return NextResponse.json({ id, status: 'recording' }, { status: 201 });
  } catch (error) {
    console.error('[Session API] Error initializing session:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
