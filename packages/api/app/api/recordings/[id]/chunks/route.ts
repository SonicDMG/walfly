import { recordChunkTranscript } from '@/lib/store';
import { transcribeAudioBytes } from '@/lib/transcribe';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: recordingId } = await params;
    const formData = await req.formData();

    const audioFile = formData.get('audio') as Blob | null;
    if (!audioFile) {
      return NextResponse.json({ error: 'Missing audio file in form data' }, { status: 400 });
    }

    const chunkIndex = parseInt(String(formData.get('chunkIndex') ?? '0'), 10);
    const offsetMs = parseInt(String(formData.get('offsetMs') ?? '0'), 10);
    const duration = parseFloat(String(formData.get('duration') ?? '0'));

    const arrayBuffer = await audioFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const audioFilename = (audioFile as File).name || `chunk-${chunkIndex}.webm`;

    // Ephemeral Transcription: send bytes straight to sidecar/ASR service
    const transcript = await transcribeAudioBytes(bytes, audioFilename, offsetMs);

    // An empty transcript means the sidecar detected silence and short-circuited.
    // There is nothing to store, but the chunk is still counted as processed so
    // the session can finalize correctly.
    if (transcript) {
      // Record stitched transcript and mark chunk as transcribed + purged
      await recordChunkTranscript({
        recordingId,
        chunkIndex,
        duration,
        offsetMs,
        transcript,
        deletedAt: new Date().toISOString(),
      });
    } else {
      console.log(`[Chunks API] ${recordingId} chunk ${chunkIndex}: silent — skipping transcript storage`);
    }

    return NextResponse.json(
      {
        recordingId,
        chunkIndex,
        status: transcript ? 'transcribed' : 'silent',
        transcriptLength: transcript.length,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[Chunks API] Error processing chunk:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 },
    );
  }
}
