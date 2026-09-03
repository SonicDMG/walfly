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
}): Promise<WebRecordingHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = options.mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    ...(options.audioBitsPerSecond ? { audioBitsPerSecond: options.audioBitsPerSecond } : {}),
  });

  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let endedEarly = false;
  let settle: ((result: WebRecordingResult) => void) | null = null;

  const releaseStream = () => stream.getTracks().forEach((track) => track.stop());

  const finalize = () => {
    releaseStream();
    document.removeEventListener('visibilitychange', flushOnHide);
    if (!settle) return;
    const resolve = settle;
    settle = null;
    resolve({
      blob: new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }),
      durationMillis: Date.now() - startedAt,
      endedEarly,
    });
  };

  const flushOnHide = () => {
    if (document.visibilityState === 'hidden' && recorder.state === 'recording') {
      recorder.requestData();
    }
  };

  recorder.addEventListener('dataavailable', (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  });
  recorder.addEventListener('stop', finalize);
  // The engine still fires a trailing dataavailable + stop pair for this per
  // spec, so no separate handling is needed here beyond noting it happened.
  recorder.addEventListener('error', () => {
    endedEarly = true;
  });
  document.addEventListener('visibilitychange', flushOnHide);

  recorder.start(DEFAULT_TIMESLICE_MS);

  return {
    stop() {
      return new Promise<WebRecordingResult>((resolve) => {
        settle = resolve;
        if (recorder.state === 'inactive') {
          // Already halted before this call landed — no more chunks are coming.
          endedEarly = true;
          finalize();
          return;
        }
        setTimeout(() => {
          if (settle) {
            endedEarly = true;
            finalize();
          }
        }, STOP_EVENT_FALLBACK_MS);
        recorder.stop();
      });
    },
    cancel() {
      settle = null;
      document.removeEventListener('visibilitychange', flushOnHide);
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Already stopping/stopped.
        }
      }
      releaseStream();
    },
  };
}
