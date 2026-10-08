import { detectMusicFromAudio } from '@/lib/music';
import { recordChunkTranscript, storeMusicDetection } from '@/lib/store';
import { transcribeAudioBytes } from '@/lib/transcribe';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// ---------------------------------------------------------------------------
// Music detection accumulation buffer
//
// 15-second chunks give the multimodal LLM too little audio context for
// reliable song identification. We accumulate 8 consecutive non-silent chunks
// (~120 s) per recording, then fire a single detection call on the combined
// buffer. The buffer is module-level so it survives across requests in the
// same Node.js process lifetime.
// ---------------------------------------------------------------------------
const MUSIC_CHUNKS_REQUIRED = 8;

interface MusicBuffer {
  chunks: Uint8Array[];
  firstOffsetMs: number;
}
const musicBuffers = new Map<string, MusicBuffer>();

function flushMusicBuffer(recordingId: string, filename: string): void {
  const buf = musicBuffers.get(recordingId);
  if (!buf || buf.chunks.length < MUSIC_CHUNKS_REQUIRED) return;

  // Concatenate all accumulated chunk bytes into one buffer
  const totalLength = buf.chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of buf.chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const firstOffsetMs = buf.firstOffsetMs;

  // Clear the buffer immediately before the async call so the next 4 chunks
  // start accumulating straight away regardless of detection latency.
  musicBuffers.delete(recordingId);

  void detectMusicFromAudio(combined, filename, firstOffsetMs).then((result) => {
    if (result.detected) {
      void storeMusicDetection(recordingId, result).catch((e) =>
        console.warn('[Chunks API] Failed to store music detection:', e),
      );
    }
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: recordingId } = await params;
    const formData = await req.formData();

    const chunkIndex = parseInt(String(formData.get('chunkIndex') ?? '0'), 10);
    const offsetMs = parseInt(String(formData.get('offsetMs') ?? '0'), 10);
    const duration = parseFloat(String(formData.get('duration') ?? '0'));
    const silent = formData.get('silent') === 'true';

    const audioFile = formData.get('audio') as Blob | null;

    // When the client detected silence locally (no audio blob sent), skip the
    // ASR service entirely and just record the gap as a silent chunk.
    if (!audioFile && silent) {
      await recordChunkTranscript({
        recordingId,
        chunkIndex,
        duration,
        offsetMs,
        transcript: '',
        deletedAt: new Date().toISOString(),
        silent: true,
      });

      return NextResponse.json(
        { status: 'silent', chunkIndex },
        { status: 200 },
      );
    }

    if (!audioFile) {
      return NextResponse.json({ error: 'Missing audio file in form data' }, { status: 400 });
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const audioFilename = (audioFile as File).name || `chunk-${chunkIndex}.webm`;

    // Music detection: accumulate non-silent chunks and detect every 8th (~120 s).
    // Fire-and-forget so the chunk response is never delayed.
    const existing = musicBuffers.get(recordingId);
    if (existing) {
      existing.chunks.push(bytes);
    } else {
      musicBuffers.set(recordingId, { chunks: [bytes], firstOffsetMs: offsetMs });
    }
    if ((musicBuffers.get(recordingId)?.chunks.length ?? 0) >= MUSIC_CHUNKS_REQUIRED) {
      flushMusicBuffer(recordingId, audioFilename);
    }

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
