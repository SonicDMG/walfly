/**
 * /api/recordings/[id]
 *
 * GET    — fetch a single recording (the detail screen and the status poll)
 * PATCH  — update the user-editable metadata: title, tags, notes, placeName
 * DELETE — remove the document and its stored audio
 *
 * PATCH validates types AND lengths before writing: `title` and `placeName`
 * are indexed, and any indexed string over 8,000 UTF-8 bytes fails the whole
 * Data API command with SHRED_DOC_LIMIT_VIOLATION.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRecordingsCollection, clampTags, MAX_TAGS, MAX_TAG_CHARS, INDEXED_STRING_MAX_CHARS } from '@walfly/db';
import { deleteAudio } from '@/lib/storage';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

const MAX_NOTES_CHARS = 20_000;

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  try {
    const recording = await getRecordingsCollection().findOne({ _id: id });
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }
    return NextResponse.json(recording);
  } catch (err) {
    logDataApiError('get', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load recording' },
      { status: 500 },
    );
  }
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }

  const $set: Record<string, any> = {};

  if ('title' in body) {
    if (typeof body.title !== 'string') {
      return NextResponse.json({ error: '`title` must be a string' }, { status: 400 });
    }
    const title = body.title.trim();
    if (title.length > INDEXED_STRING_MAX_CHARS) {
      return NextResponse.json(
        { error: `\`title\` must be at most ${INDEXED_STRING_MAX_CHARS} characters` },
        { status: 400 },
      );
    }
    $set.title = title;
  }

  if ('tags' in body) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) {
      return NextResponse.json({ error: '`tags` must be an array of strings' }, { status: 400 });
    }
    if (body.tags.length > MAX_TAGS) {
      return NextResponse.json({ error: `\`tags\` may hold at most ${MAX_TAGS} entries` }, { status: 400 });
    }
    if ((body.tags as string[]).some((t) => t.length > MAX_TAG_CHARS)) {
      return NextResponse.json(
        { error: `each tag must be at most ${MAX_TAG_CHARS} characters` },
        { status: 400 },
      );
    }
    $set.tags = clampTags(body.tags);
  }

  if ('notes' in body) {
    if (typeof body.notes !== 'string') {
      return NextResponse.json({ error: '`notes` must be a string' }, { status: 400 });
    }
    if (body.notes.length > MAX_NOTES_CHARS) {
      return NextResponse.json(
        { error: `\`notes\` must be at most ${MAX_NOTES_CHARS} characters` },
        { status: 400 },
      );
    }
    $set.notes = body.notes;
  }

  // `location.placeName` is accepted as an alias for the flat `placeName`.
  const placeNameKey = 'placeName' in body ? 'placeName' : 'location.placeName' in body ? 'location.placeName' : null;
  if (placeNameKey) {
    const value = body[placeNameKey];
    if (typeof value !== 'string') {
      return NextResponse.json({ error: '`placeName` must be a string' }, { status: 400 });
    }
    const placeName = value.trim();
    if (placeName.length > INDEXED_STRING_MAX_CHARS) {
      return NextResponse.json(
        { error: `\`placeName\` must be at most ${INDEXED_STRING_MAX_CHARS} characters` },
        { status: 400 },
      );
    }
    $set['location.placeName'] = placeName;
  }

  if (Object.keys($set).length === 0) {
    return NextResponse.json({ error: 'No patchable fields provided' }, { status: 400 });
  }

  try {
    // Inside the try: the accessor performs the Astra env check, and an uncaught
    // throw would answer with an empty-bodied 500.
    const collection = getRecordingsCollection();

    const result = await collection.updateOne({ _id: id }, { $set });
    if (result.matchedCount === 0) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    const recording = await collection.findOne({ _id: id });
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, recording });
  } catch (err) {
    const code = dataApiErrorCode(err);
    logDataApiError('patch', err);
    // A rejected document is the caller's problem; anything else is ours.
    const status = code === 'SHRED_DOC_LIMIT_VIOLATION' || code === 'INVALID_VECTORIZE_VALUE_TYPE' ? 400 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update recording', code },
      { status },
    );
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const collection = getRecordingsCollection();

    const recording = await collection.findOne({ _id: id });
    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    // Best effort: a missing audio object must not block deleting the document.
    if (recording.audioUrl) {
      await deleteAudio(recording.audioUrl).catch((err: unknown) => {
        console.warn(`[recordings] ${id} audio delete failed (continuing):`, err);
      });
    }

    await collection.deleteOne({ _id: id });

    return NextResponse.json({ success: true });
  } catch (err) {
    logDataApiError('delete', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete recording' },
      { status: 500 },
    );
  }
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

function dataApiErrorCode(err: unknown): string | undefined {
  return (err as { errorDescriptors?: Array<{ errorCode?: string }> })?.errorDescriptors?.[0]?.errorCode;
}

function logDataApiError(phase: string, err: unknown): void {
  const code = dataApiErrorCode(err);
  console.error(
    `[recordings] ${phase} failed${code ? ` (${code})` : ''}:`,
    err instanceof Error ? err.message : err,
  );
}
