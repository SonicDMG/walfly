/**
 * POST /api/recordings/upload
 *
 * Accepts a multipart/form-data upload with:
 *   audio          - audio file blob
 *   duration       - recording duration in seconds (string)
 *   clientTimestamp - ISO timestamp from the client at record-start
 *   lat            - latitude (optional, string)
 *   lng            - longitude (optional, string)
 *   placeName      - reverse-geocoded place name (optional, string)
 *
 * Flow:
 *   1. Store audio (Vercel Blob if BLOB_READ_WRITE_TOKEN is set, else local tmpdir)
 *   2. Insert Recording doc into Astra DB with status "processing"
 *   3. Return { id, status } immediately
 *   4. Fire-and-forget: kick off enrichment pipeline
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRecordingsCollection } from '@walfly/db';
import { enrichRecording } from '@/lib/pipeline';
import { storeAudio } from '@/lib/storage';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  console.log('[upload] Incoming request — content-type:', req.headers.get('content-type'));

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error('[upload] Failed to parse multipart/form-data:', err);
    return NextResponse.json({ error: 'Invalid multipart/form-data' }, { status: 400 });
  }

  console.log('[upload] Form fields received:', [...formData.keys()]);

  const audioFile = formData.get('audio');
  if (!audioFile || !(audioFile instanceof Blob)) {
    console.error('[upload] Missing or invalid audio field — got:', typeof audioFile, audioFile?.constructor?.name);
    return NextResponse.json({ error: 'Missing audio field' }, { status: 400 });
  }

  console.log('[upload] Audio file — type:', (audioFile as File).type, 'size:', audioFile.size, 'bytes');

  const duration = Number(formData.get('duration') ?? '0');
  const clientTimestamp = (formData.get('clientTimestamp') as string | null) ?? new Date().toISOString();
  const lat = formData.get('lat') ? Number(formData.get('lat')) : null;
  const lng = formData.get('lng') ? Number(formData.get('lng')) : null;
  const placeName = (formData.get('placeName') as string | null) ?? null;

  const id = uuidv4();
  // Use the extension from the uploaded file so storage and transcription
  // see the correct format (.mp4 from web, .m4a from native).
  const uploadedName = (audioFile as File).name ?? 'recording.m4a';
  const ext = uploadedName.includes('.') ? uploadedName.split('.').pop() : 'm4a';
  const filename = `recordings/${id}.${ext}`;

  // 1. Store audio
  let audioUrl: string;
  try {
    audioUrl = await storeAudio(filename, audioFile);
  } catch (err) {
    console.error('[upload] Audio storage failed:', err);
    return NextResponse.json({ error: 'Audio upload failed' }, { status: 500 });
  }

  // 2. Insert recording doc into Astra DB
  const collection = getRecordingsCollection();
  try {
    await collection.insertOne({
      _id: id,
      title: `Recording ${new Date(clientTimestamp).toLocaleString()}`,
      createdAt: clientTimestamp,
      duration,
      audioUrl,
      location:
        lat !== null && lng !== null
          ? { coords: { lat, lng }, placeName }
          : null,
      status: 'processing',
      transcript: null,
      summary: null,
      keyTakeaways: [],
      actionItems: [],
      speakers: [],
      tags: [],
      notes: '',
    });
  } catch (err) {
    console.error('[upload] Astra DB insert failed:', err);
    return NextResponse.json({ error: 'Database insert failed' }, { status: 500 });
  }

  // 3. Return immediately
  const response = NextResponse.json({ id, status: 'processing' }, { status: 201 });

  // 4. Fire-and-forget enrichment pipeline
  // waitUntil is not available in standard Next.js outside of middleware/edge;
  // we use a detached promise here. On Vercel, the function stays alive until
  // the async work completes when using Node.js runtime.
  enrichRecording(id, audioUrl).catch((err: unknown) => {
    console.error('[upload] enrichRecording failed:', err);
  });

  return response;
}
