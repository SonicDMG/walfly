import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { RECOVER_MAX_BYTES, isRecoverPathnameFor } from '@/lib/recoverPolicy';
import { storageMode } from '@/lib/storage';
import { getRecordingsV2Collection } from '@walfly/db';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ALLOWED_CONTENT_TYPES = [
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/mpeg',
  'audio/flac',
  'audio/webm',
  'application/octet-stream',
];

/**
 * POST /api/recordings/{id}/recover/upload
 *
 * The Vercel Blob `handleUpload` token exchange: the client proposes the
 * deterministic recovery pathname and receives a short-lived, pathname-scoped
 * client token, then uploads directly to Blob (bypassing the function body
 * limit). The object is NOT attached here — `POST /recover/complete` is the
 * single attach authority, because `onUploadCompleted` cannot reach local dev.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (storageMode() !== 'blob') {
    return NextResponse.json(
      { error: 'Local storage mode — upload via /recover/audio', code: 'local_mode' },
      { status: 409 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!isRecoverPathnameFor(id, pathname)) {
          throw new Error('Unexpected recovery pathname');
        }
        const doc = await getRecordingsV2Collection().findOne(
          { _id: id },
          { projection: { status: 1, recover: 1 } },
        );
        if (doc) {
          const status = String(doc.status);
          if (
            doc.recover?.attachedAt ||
            status === 'ready' || status === 'failed' ||
            status === 'transcribing' || status === 'enriching'
          ) {
            throw new Error('already_attached');
          }
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: RECOVER_MAX_BYTES,
          addRandomSuffix: false,
          validUntil: Date.now() + 24 * 60 * 60 * 1000,
          tokenPayload: JSON.stringify({ recordingId: id }),
        };
      },
      onUploadCompleted: async () => {
        // Deliberately a no-op: this callback cannot reach a local dev server,
        // and /recover/complete is the one attach path in both modes.
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[Recover Upload API] Token exchange failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Token exchange failed' },
      { status: 400 },
    );
  }
}
