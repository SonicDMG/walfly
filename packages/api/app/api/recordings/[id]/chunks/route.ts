import { addChunkToMusicBuffer, detectMusicFromBytes, detectMusicFromChunks, markMusicDetected } from '@/lib/music';
import { recordChunkTranscript, storeMusicDetection } from '@/lib/store';
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

    // Music detection: accumulate 4 chunks (≈60 s) before fingerprinting.
    // Individual 15 s chunks are too short for reliable AcoustID matching, so
    // we buffer consecutive chunks and fingerprint the combined 60 s buffer.
    // The buffer is module-level and persists in `next dev` (single process);
    // in cold-start serverless it starts empty and we fall back to per-chunk
    // detection on the first chunk of each recording.
    const { combined, single, skip } = addChunkToMusicBuffer(recordingId, {
      bytes,
      filename: audioFilename,
    });

    if (!skip) {
      if (combined) {
        // Got 4 chunks — fingerprint the 60 s combined buffer.
        void detectMusicFromChunks(combined).then((result) => {
          if (result.detected) {
            void storeMusicDetection(recordingId, result).catch((e) =>
              console.warn('[Chunks API] Failed to store music detection:', e),
            );
            markMusicDetected(recordingId);
          }
        }).catch(() => { /* already non-throwing, belt-and-suspenders */ });
      }
      if (single) {
        // Per-chunk fallback: run detection on this individual 15 s chunk.
        void detectMusicFromBytes(single.bytes, single.filename).then((result) => {
          if (result.detected) {
            void storeMusicDetection(recordingId, result).catch((e) =>
              console.warn('[Chunks API] Failed to store music detection:', e),
            );
            markMusicDetected(recordingId);
          }
        }).catch(() => { /* already non-throwing, belt-and-suspenders */ });
      }
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
