/**
 * GET /api/recordings/audio/[filename]
 *
 * Serves audio from the local audio directory when running without Vercel Blob.
 * On a deployment with Blob configured the recording's audioUrl is already an
 * absolute public URL, so this route answers 404 and nothing else.
 *
 * Two properties matter here. The filename is validated as a bare basename
 * before the filesystem is touched — the previous implementation decoded the
 * path segment a second time and joined it straight onto tmpdir, which served
 * arbitrary readable files. And the body is streamed with Range support, so a
 * long recording is neither buffered into the function's heap nor capped by the
 * platform's 4.5 MB response limit, and <audio> can seek.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { contentTypeForExtension, localAudioPath, storageMode } from '@/lib/storage';

export const runtime = 'nodejs';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
): Promise<Response> {
  const { filename } = await params;

  // Deliberately NOT decoded again: the router already decoded this segment,
  // and a second decode is what turned %252e%252e%252f into a traversal.
  if (!filename || !SAFE_NAME.test(filename) || filename.includes('..')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (storageMode() !== 'local') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const filepath = localAudioPath(filename);
  if (!filepath) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let size: number;
  try {
    const info = await stat(filepath);
    if (!info.isFile()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    size = info.size;
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  const contentType = contentTypeForExtension(extension);

  const range = parseRange(req.headers.get('range'), size);

  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
    });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;

  const body = Readable.toWeb(
    createReadStream(filepath, { start, end }),
  ) as unknown as ReadableStream<Uint8Array>;

  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0, must-revalidate',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

/**
 * Parses a single-range `Range` header. Returns null when absent or not a byte
 * range, and 'invalid' when the range cannot be satisfied.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start: number;
  let end: number;

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';

  return { start, end: Math.min(end, size - 1) };
}
