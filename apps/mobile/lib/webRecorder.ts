/**
 * webRecorder.ts
 *
 * Web-only fallback; every browser API reference inside is guarded at call time.
 *
 * expo-av's web `Audio.Recording` only ever produces one blob, assembled from a
 * single `dataavailable` listener that it attaches right before calling
 * `MediaRecorder.stop()`. If the browser has already halted the recorder by
 * then — the tab was backgrounded, the screen locked, the mic was lost — that
 * listener was never there to catch the trailing `dataavailable` the spec still
 * fires, and the whole recording is lost even though `stopAndUnloadAsync()`
 * resolves without error.
 *
 * This drives MediaRecorder directly instead, listening for `dataavailable`
 * from the moment recording starts (via a timeslice) and accumulating chunks
 * as they arrive, so whatever was captured survives an interruption. Per spec,
 * both a normal `stop()` and an engine-initiated halt still emit a trailing
 * `dataavailable` with the remaining buffered audio before `stop` fires.
 */

const DEFAULT_TIMESLICE_MS = 1000;
/** Safari on iOS has been observed not to fire `stop` after `stop()` is called. */
const STOP_EVENT_FALLBACK_MS = 3000;

export interface WebRecordingResult {
  blob: Blob;
  durationMillis: number;
  /** True if the browser halted capture on its own before `stop()` was called. */
  endedEarly: boolean;
}

export interface WebRecordingHandle {
  /** Stops recording and resolves with whatever audio was captured, even if cut short. */
  stop(): Promise<WebRecordingResult>;
  /** Releases the microphone without producing a result. */
  cancel(): void;
}

export async function startWebRecording(options: {
  mimeTypes: readonly string[];
  audioBitsPerSecond?: number;
  onChunk?: (chunkBlob: Blob, durationMillis: number) => void;
  chunkIntervalMs?: number;
}): Promise<WebRecordingHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = options.mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    ...(options.audioBitsPerSecond ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
  });

  const allRecordedChunks: Blob[] = [];
  const startedAt = Date.now();
  let currentRecorder: MediaRecorder | null = null;
  let currentChunkBlobs: Blob[] = [];
  let chunkStartTime = startedAt;
  let isStopped = false;
  let settle: ((result: WebRecordingResult) => void) | null = null;
  let chunkTimer: ReturnType<typeof setInterval> | null = null;

  const createSegmentRecorder = () => {
    const rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      ...(options.audioBitsPerSecond ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
    });

    rec.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) {
        currentChunkBlobs.push(event.data);
        allRecordedChunks.push(event.data);
      }
    });

    return rec;
  };

  currentRecorder = createSegmentRecorder();

  const cycleChunk = () => {
    if (isStopped || !currentRecorder) return;

    const oldRecorder = currentRecorder;
    const oldBlobs = currentChunkBlobs;
    const chunkDuration = Date.now() - chunkStartTime;

    // Start next segment with a fresh standalone MediaRecorder instance
    currentChunkBlobs = [];
    chunkStartTime = Date.now();
    currentRecorder = createSegmentRecorder();
    currentRecorder.start();

    // Stop old segment — when stop fires, emit complete standalone container
    oldRecorder.addEventListener('stop', () => {
      if (oldBlobs.length > 0 && options.onChunk) {
        const sliceBlob = new Blob(oldBlobs, { type: oldRecorder.mimeType || mimeType || 'audio/webm' });
        options.onChunk(sliceBlob, chunkDuration);
      }
    });

    if (oldRecorder.state !== 'inactive') {
      try {
        oldRecorder.stop();
      } catch {}
    }
  };

  const releaseStream = () => stream.getTracks().forEach((track) => track.stop());

  currentRecorder.start();

  if (options.chunkIntervalMs && options.onChunk) {
    chunkTimer = setInterval(() => {
      cycleChunk();
    }, options.chunkIntervalMs);
  }

  return {
    stop() {
      return new Promise<WebRecordingResult>((resolve) => {
        isStopped = true;
        if (chunkTimer) {
          clearInterval(chunkTimer);
          chunkTimer = null;
        }

        const activeRec = currentRecorder;
        const lastBlobs = currentChunkBlobs;
        const lastDuration = Date.now() - chunkStartTime;

        const onFinalStop = () => {
          if (lastBlobs.length > 0 && options.onChunk) {
            const sliceBlob = new Blob(lastBlobs, { type: activeRec?.mimeType || mimeType || 'audio/webm' });
            options.onChunk(sliceBlob, lastDuration);
          }
          releaseStream();
          resolve({
            blob: new Blob(allRecordedChunks, { type: activeRec?.mimeType || mimeType || 'audio/webm' }),
            durationMillis: Date.now() - startedAt,
            endedEarly: false,
          });
        };

        if (!activeRec || activeRec.state === 'inactive') {
          onFinalStop();
        } else {
          activeRec.addEventListener('stop', onFinalStop);
          try {
            activeRec.stop();
          } catch {
            onFinalStop();
          }
        }
      });
    },
    cancel() {
      isStopped = true;
      if (chunkTimer) {
        clearInterval(chunkTimer);
        chunkTimer = null;
      }
      releaseStream();
      if (currentRecorder && currentRecorder.state !== 'inactive') {
        try {
          currentRecorder.stop();
        } catch {}
      }
    },
  };
}
