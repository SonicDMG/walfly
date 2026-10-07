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
  // Fallback Web Audio API RMS/dB metering for browser silence gating
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  let windowPeakDb = -Infinity;
  const SILENCE_DBFS_GATE = -45; // Below -45 dBFS is treated as silence

  const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
  const shouldEnableVAD = options.vadEnabled !== false && isBrowser;

  if (shouldEnableVAD) {
    try {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        audioCtx = new AudioCtxClass();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        sourceNode = audioCtx.createMediaStreamSource(stream);
        sourceNode.connect(analyser);

        const dataArray = new Float32Array(analyser.fftSize);
        meterTimer = setInterval(() => {
          if (!analyser) return;
          analyser.getFloatTimeDomainData(dataArray);
          let sumSquares = 0;
          for (let i = 0; i < dataArray.length; i++) {
            sumSquares += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sumSquares / dataArray.length);
          const db = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
          if (db > windowPeakDb) {
            windowPeakDb = db;
          }
          if (db >= SILENCE_DBFS_GATE) {
            hadSpeech = true;
          }
        }, 100);
      } else {
        hadSpeech = true;
      }
    } catch (err) {
      console.warn('[WebRecorder] AudioContext metering init failed, falling back to speech=true:', err);
      hadSpeech = true;
    }
  } else {
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
    const segmentHadSpeech = hadSpeech || windowPeakDb >= SILENCE_DBFS_GATE;

    // Reset speech flag and peak dB for next chunk window
    hadSpeech = false;
    windowPeakDb = -Infinity;

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

        const segmentHadSpeech = hadSpeech || windowPeakDb >= SILENCE_DBFS_GATE;

        if (meterTimer) {
          clearInterval(meterTimer);
          meterTimer = null;
        }
        if (sourceNode) {
          try { sourceNode.disconnect(); } catch {}
          sourceNode = null;
        }
        if (audioCtx) {
          try { audioCtx.close(); } catch {}
          audioCtx = null;
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
      if (meterTimer) {
        clearInterval(meterTimer);
        meterTimer = null;
      }
      if (sourceNode) {
        try { sourceNode.disconnect(); } catch {}
        sourceNode = null;
      }
      if (audioCtx) {
        try { audioCtx.close(); } catch {}
        audioCtx = null;
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
