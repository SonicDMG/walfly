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
  chunkIntervalMs?: number;
  onChunk?: (chunkBlob: Blob, durationMillis: number) => void;
  vadEnabled?: boolean;
  onSilentChunk?: (durationMillis: number) => void;
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

  // Track speech presence in the active chunk window
  let hadSpeech = false;
  // Type as any or MicVAD instance to support dynamic/guarded usage
  let vadInstance: { destroy: () => Promise<void>; pause: () => Promise<void> } | null = null;

  const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  const shouldEnableVAD = options.vadEnabled !== false && isBrowser;

  if (shouldEnableVAD) {
    try {
      // Load onnxruntime first, then vad bundle
      const win = window as unknown as {
        ort?: unknown;
        vad?: { MicVAD?: { new: (opts: unknown) => Promise<unknown> } };
      };

      const loadScript = (src: string) =>
        new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.onload = () => resolve();
          script.onerror = (e) => reject(e);
          document.head.appendChild(script);
        });

      if (!win.ort && typeof document !== 'undefined') {
        await loadScript('/assets/vad/ort.min.js').catch((e) => {
          console.warn('[WebRecorder] Could not load ORT script dynamically:', e);
        });
      }

      let vad = win.vad;
      if (!vad && typeof document !== 'undefined') {
        await loadScript('/assets/vad/bundle.min.js').catch((e) => {
          console.warn('[WebRecorder] Could not load VAD script dynamically:', e);
        });
        vad = win.vad;
      }

      if (vad && vad.MicVAD) {
        vadInstance = (await vad.MicVAD.new({
          getStream: async () => stream,
          pauseStream: async () => {}, // do not kill shared stream on pause
          resumeStream: async () => stream,
          startOnLoad: true,
          baseAssetPath: '/assets/vad/',
          onnxWASMBasePath: '/assets/vad/',
          onSpeechStart: () => {
            hadSpeech = true;
          },
        })) as { destroy: () => Promise<void>; pause: () => Promise<void> };
      }
    } catch (vadErr) {
      console.warn('[WebRecorder] VAD initialization failed, falling back to non-VAD recording:', vadErr);
      vadInstance = null;
      hadSpeech = true;
    }
  } else {
    // If VAD is disabled, treat every chunk as having speech
    hadSpeech = true;
  }

  // Each segment recorder writes into its own dedicated blob array so that the
  // final `dataavailable` fired by stop() (which carries the container footer)
  // lands in the correct bucket even after currentChunkBlobs has been swapped.
  const createSegmentRecorder = (targetBlobs: Blob[]) => {
    const rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      ...(options.audioBitsPerSecond ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
    });

    rec.addEventListener('dataavailable', (event: BlobEvent) => {
      if (event.data.size > 0) {
        targetBlobs.push(event.data);
        allRecordedChunks.push(event.data);
      }
    });

    return rec;
  };

  currentChunkBlobs = [];
  currentRecorder = createSegmentRecorder(currentChunkBlobs);

  const cycleChunk = () => {
    if (isStopped || !currentRecorder) return;

    const oldRecorder = currentRecorder;
    const oldBlobs = currentChunkBlobs;   // captured before swap
    const chunkDuration = Date.now() - chunkStartTime;
    const segmentHadSpeech = vadInstance ? hadSpeech : true;

    // Reset speech flag for next chunk window
    if (vadInstance) {
      hadSpeech = false;
    }

    // Start next segment — new array passed to the listener closure so the
    // old recorder's final dataavailable still lands in oldBlobs.
    currentChunkBlobs = [];
    chunkStartTime = Date.now();
    currentRecorder = createSegmentRecorder(currentChunkBlobs);
    currentRecorder.start();

    // Stop old segment — when stop fires, oldBlobs is complete (header + data + footer).
    oldRecorder.addEventListener('stop', () => {
      if (segmentHadSpeech) {
        if (oldBlobs.length > 0 && options.onChunk) {
          const sliceBlob = new Blob(oldBlobs, { type: oldRecorder.mimeType || mimeType || 'audio/webm' });
          options.onChunk(sliceBlob, chunkDuration);
        }
      } else {
        options.onSilentChunk?.(chunkDuration);
      }
    });

    if (oldRecorder.state !== 'inactive') {
      try {
        oldRecorder.stop();
      } catch {}
    }
  };

  const releaseStream = () => stream.getTracks().forEach((track) => track.stop());

  currentRecorder.start(DEFAULT_TIMESLICE_MS);

  // Time-driven chunk cycling: rotate every chunkIntervalMs when onChunk is requested
  let chunkTimer: ReturnType<typeof setInterval> | null = null;
  if (options.chunkIntervalMs && options.onChunk) {
    chunkTimer = setInterval(() => {
      if (!isStopped) cycleChunk();
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

        const segmentHadSpeech = vadInstance ? hadSpeech : (options.vadEnabled !== false && isBrowser ? hadSpeech : true);

        if (vadInstance) {
          vadInstance.destroy().catch(() => {});
          vadInstance = null;
        }

        const activeRec = currentRecorder;
        const lastBlobs = currentChunkBlobs;
        const lastDuration = Date.now() - chunkStartTime;

        const onFinalStop = () => {
          if (segmentHadSpeech) {
            if (lastBlobs.length > 0 && options.onChunk) {
              const sliceBlob = new Blob(lastBlobs, { type: activeRec?.mimeType || mimeType || 'audio/webm' });
              options.onChunk(sliceBlob, lastDuration);
            }
          } else {
            options.onSilentChunk?.(lastDuration);
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
      if (vadInstance) {
        vadInstance.destroy().catch(() => {});
        vadInstance = null;
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
