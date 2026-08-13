/**
 * /api/recordings/[id]
 *
 * GET    — fetch a single recording by ID (also used to poll status)
 * PATCH  — update editable metadata fields (title, tags, notes, location.placeName)
 * DELETE — remove the recording from Astra DB and delete the Vercel Blob asset
 */

import { NextRequest, NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { getRecordingsCollection } from '@walfly/db';

type RouteContext = { params: Promise<{ id: string }> };

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const collection = getRecordingsCollection();
  const recording = await collection.findOne({ _id: id });

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }

  return NextResponse.json(recording);
}

// ─── PATCH ───────────────────────────────────────────────────────────────────

const PATCHABLE_FIELDS = new Set(['title', 'tags', 'notes', 'location.placeName']);

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Filter to only allowed fields
  const $set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PATCHABLE_FIELDS.has(key)) {
      $set[key] = value;
    }
  }

  if (Object.keys($set).length === 0) {
    return NextResponse.json({ error: 'No patchable fields provided' }, { status: 400 });
  }

  const collection = getRecordingsCollection();
  const result = await collection.updateOne({ _id: id }, { $set });

  if (result.matchedCount === 0) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(_req: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const collection = getRecordingsCollection();

  // Fetch first to get the blob URL
  const recording = await collection.findOne({ _id: id });
  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
  }

  // Delete blob (best-effort — don't fail the whole request if blob is missing)
  if (recording.audioUrl) {
    await del(recording.audioUrl).catch((err: unknown) => {
      console.warn('[delete] Vercel Blob delete failed (continuing):', err);
    });
  }

  // Delete Astra DB doc
  await collection.deleteOne({ _id: id });

  return NextResponse.json({ success: true });
}
