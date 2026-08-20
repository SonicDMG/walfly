/**
 * GET /api/recordings/audio/:filename
 *
 * Serves audio files from the OS tmpdir when running locally without Vercel Blob.
 * Not used in production (Vercel Blob returns a public URL directly).
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  const filepath = join(tmpdir(), decodeURIComponent(filename));

  let data: ArrayBuffer;
  try {
    const buf = await readFile(filepath);
    data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return new NextResponse(data, {
    headers: {
      'Content-Type': 'audio/webm',
      'Cache-Control': 'no-store',
    },
  });
}
