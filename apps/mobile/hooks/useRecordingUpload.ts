/**
 * useRecordingUpload.ts
 *
 * The full record → upload → drive-the-pipeline lifecycle on web and native.
 *
 * Contract this file enforces, and why each part exists:
 *   - Microphone permission is requested on every platform before recording;
 *     the iOS module rejects prepareToRecordAsync without it.
 *   - The iOS audio session is switched into record mode before recording and
 *     back out afterwards, so later playback is not routed to the earpiece.
 *   - Audio is captured at 32 kbps mono 22.05 kHz. Whisper resamples to 16 kHz
 *     mono anyway, and this keeps a 15-minute walk small enough for the 4 MB
 *     request-body cap Vercel enforces at the routing layer.
 *   - The container is negotiated to one Docling's ASR pipeline accepts. Where
 *     the browser can only produce WebM — which Docling classifies as VIDEO —
 *     the recording is decoded and re-encoded as WAV before upload, because
 *     relabelling a Blob's MIME type transcodes nothing and the server
 *     re-sniffs the bytes anyway.
 *   - The file is uploaded with its TRUE type. On native the file URI is handed
 *     to FormData directly, because React Native's Blob cannot be built from a
 *     Uint8Array and its FormData only serialises { uri, name, type } parts.
 *   - On web, recording bypasses expo-av's Audio.Recording and drives
 *     MediaRecorder directly (see lib/webRecorder.ts), because expo-av only
 *     captures audio in a single blob assembled at stop() time — if the
 *     browser halts the recorder first (backgrounded tab, locked screen),
 *     that blob is never produced and the whole recording is lost silently.
 *     Chunked capture means whatever was recorded before an interruption
 *     still uploads.
 *   - Nothing runs in the background on the server: this hook polls
 *     POST /api/recordings/{id}/process, and each tick advances the job one step.
 *   - Every timer, recorder and in-flight request is torn down on unmount, and
 *     no state is set afterwards.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  AudioModule,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
} from 'expo-audio';
import { File as ExpoFile } from 'expo-file-system';
import {
  apiUrl,
  describeRequestError,
  type ProcessResponse,
  type RecordingStatus,
  type UploadResponse,
} from '../lib/api';
import { useLocationPermission, type LocationSnapshot } from './useLocationPermission';
// Web-only in practice; every Web Audio reference inside is guarded at call time.
import { transcodeToWav } from '../lib/audio-wav';
// Web-only in practice; every browser API reference inside is guarded at call time.
import { startWebRecording, type WebRecordingHandle } from '../lib/webRecorder';

export type RecordState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'error';

export interface UploadResult {
  id: string;
}

/** Android's MediaRecorder rejects with E_AUDIO_NODATA if stopped before any frames land. */
const MIN_RECORDING_MS = 700;
/** Hard stop, so a forgotten recorder cannot grow an unbounded upload. */
const MAX_RECORDING_MS = 15 * 60 * 1000;
/**
 * Conservative default, used only until the server reports its real ceiling via
 * GET /api/recordings/upload. Vercel returns 413 FUNCTION_PAYLOAD_TOO_LARGE
 * above 4.5 MB before the handler runs; a local server has far more headroom,
 * which matters because a WebM-only browser uploads uncompressed WAV.
 */
const FALLBACK_MAX_UPLOAD_BYTES = 4_000_000;
/** Location is optional metadata and must never delay the upload. */
const LOCATION_WAIT_MS = 4000;
/** Give up on the server-side pipeline after this long. */
const PROCESSING_DEADLINE_MS = 20 * 60 * 1000;
const AUTO_RESET_MS = 2000;

const PROGRESS_BY_STATUS: Record<RecordingStatus, number> = {
  uploaded: 0.55,
  transcribing: 0.7,
  enriching: 0.9,
  ready: 1,
  failed: 1,
};

/**
 * MediaRecorder containers, best first. Docling's ASR pipeline accepts
 * wav/mp3/m4a/aac/ogg/flac, so a browser that can produce one of those (Safari
 * → audio/mp4, Firefox → audio/ogg) uploads its recording untouched and keeps
 * Opus/AAC compression.
 *
 * The codec-qualified `audio/mp4;codecs=mp4a.40.2` is deliberately absent:
 * Chrome reports it as supported via isTypeSupported, but its AAC encoder
 * throws EncodingError as soon as an explicit low bitrate (our 32 kbps) is
 * requested against that exact codec string, so `dataavailable` never
 * carries any data. Bare `audio/mp4` produces the same AAC-in-MP4 output and
 * respects the bitrate correctly.
 *
 * WebM is last, not absent: Chrome can encode nothing else, and refusing to
 * record at all is a worse outcome than recording and converting afterwards.
 * A WebM recording is decoded and re-encoded as WAV before upload — see
 * transcodeToWav — because Docling treats webm as a VIDEO container.
 */
const WEB_MIME_PREFERENCE = [
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/webm;codecs=opus',
  'audio/webm',
] as const;

/** The exact filename + declared MIME the server is told about, keyed by the real blob type. */
const UPLOAD_SHAPE_BY_MIME: Record<string, { ext: string; mime: string }> = {
  'audio/mp4': { ext: 'm4a', mime: 'audio/mp4' },
  'audio/m4a': { ext: 'm4a', mime: 'audio/mp4' },
  'audio/x-m4a': { ext: 'm4a', mime: 'audio/mp4' },
  'audio/aac': { ext: 'aac', mime: 'audio/aac' },
  'audio/ogg': { ext: 'ogg', mime: 'audio/ogg' },
  'audio/opus': { ext: 'ogg', mime: 'audio/ogg' },
  'audio/wav': { ext: 'wav', mime: 'audio/wav' },
  'audio/wave': { ext: 'wav', mime: 'audio/wav' },
  'audio/x-wav': { ext: 'wav', mime: 'audio/wav' },
  'audio/mpeg': { ext: 'mp3', mime: 'audio/mpeg' },
  'audio/mp3': { ext: 'mp3', mime: 'audio/mpeg' },
};

export function useRecordingUpload() {
  const [state, setState] = useState<RecordState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState(0);

  const mountedRef = useRef(true);
  const recordingRef = useRef<InstanceType<typeof AudioModule.AudioRecorder> | null>(null);
  const webRecordingRef = useRef<WebRecordingHandle | null>(null);
  const startedAtRef = useRef(0);
  const startTimestampRef = useRef('');
  const locationPromiseRef = useRef<Promise<LocationSnapshot | null> | null>(null);
  const autoResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  const { requestAndCapture } = useLocationPermission();

  const safeSetState = useCallback((next: RecordState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const safeSetProgress = useCallback((next: number) => {
    if (mountedRef.current) setProgress(next);
  }, []);

  const clearTimers = useCallback(() => {
    if (autoResetTimerRef.current) {
      clearTimeout(autoResetTimerRef.current);
      autoResetTimerRef.current = null;
    }
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }
  }, []);

  /** Stops and removes any live recorder. Never throws: teardown must always complete. */
  const teardownRecorder = useCallback(async () => {
    if (Platform.OS === 'web') {
      const handle = webRecordingRef.current;
      webRecordingRef.current = null;
      handle?.cancel();
      return;
    }
    const recording = recordingRef.current;
    recordingRef.current = null;
    if (!recording) return;
    try {
      await recording.stop();
    } catch {
      // The recorder may already be stopped.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      abortRef.current?.abort();
      abortRef.current = null;
      void teardownRecorder().then(releaseIosRecordSession);
    };
  }, [clearTimers, teardownRecorder]);

  const startRecording = useCallback(async () => {
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;

    try {
      setError(null);
      setResult(null);
      safeSetProgress(0);
      safeSetState('requesting');

      // A recorder left over from a failed run keeps expo-av's module-level
      // singleton claimed, which makes every later createAsync throw.
      await teardownRecorder();

      const mic = await requestRecordingPermissionsAsync();
      if (!mic.granted) {
        throw new Error(
          'Microphone permission denied. Enable microphone access for Walfly in your system settings.',
        );
      }

      // Fired, never awaited: losing the opening seconds of speech to a
      // geocoder is not an acceptable trade for a place name.
      locationPromiseRef.current = requestAndCapture();

      startTimestampRef.current = new Date().toISOString();
      startedAtRef.current = Date.now();

      await setAudioModeAsync(RECORD_AUDIO_MODE);

      if (Platform.OS === 'web') {
        webRecordingRef.current = await startWebRecording({
          mimeTypes: WEB_MIME_PREFERENCE,
          audioBitsPerSecond: 32000,
        });
      } else {
        const recorder = new AudioModule.AudioRecorder(recordingOptions());
        await recorder.prepareToRecordAsync();
        recorder.record();
        recordingRef.current = recorder;
      }
      safeSetState('recording');

      maxDurationTimerRef.current = setTimeout(() => {
        maxDurationTimerRef.current = null;
        stopRef.current();
      }, MAX_RECORDING_MS);
    } catch (err) {
      await teardownRecorder();
      await releaseIosRecordSession();
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to start recording');
        setState('error');
      }
    }
  }, [clearTimers, requestAndCapture, safeSetProgress, safeSetState, teardownRecorder]);

  const stopAndUpload = useCallback(async () => {
    // Claimed synchronously. The MAX_RECORDING_MS timer and a double tap inside
    // the MIN_RECORDING_MS floor can both land before React commits the
    // 'uploading' state, and two calls sharing one recorder means one of them
    // fails with "already unloaded"/"already stopped" while the other uploads
    // successfully.
    const isWeb = Platform.OS === 'web';
    const recording = isWeb ? null : recordingRef.current;
    const webHandle = isWeb ? webRecordingRef.current : null;
    if (!recording && !webHandle) return;
    recordingRef.current = null;
    webRecordingRef.current = null;

    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }

    try {
      safeSetState('uploading');
      safeSetProgress(0.1);

      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed < MIN_RECORDING_MS) await sleep(MIN_RECORDING_MS - elapsed);

      const formData = new FormData();
      let durationSec: number;
      let byteSize: number;

      if (webHandle) {
        // Whatever chunks were captured before an interruption are still
        // included here — see lib/webRecorder.ts.
        const { blob: recorded, durationMillis } = await webHandle.stop();
        durationSec = Math.max(1, Math.round(durationMillis / 1000));
        // recorded.type is authoritative: the browser may have ignored the
        // mimeType we asked for. The server re-sniffs the bytes regardless.
        const prepared = await prepareWebUpload(recorded);
        byteSize = prepared.blob.size;
        assertUploadSize(byteSize, durationSec, await fetchMaxUploadBytes());
        formData.append('audio', prepared.blob, `recording.${prepared.ext}`);
        formData.append('audioMimeType', prepared.mime);
      } else if (recording) {
        let stopError: unknown = null;
        try {
          await recording.stop();
        } catch (err) {
          stopError = err;
        }
        const uri = recording.uri;

        // Put the iOS session back to playback before anything else can fail.
        await releaseIosRecordSession();

        if (stopError) {
          throw new Error(
            `Recording could not be finalised: ${
              stopError instanceof Error ? stopError.message : String(stopError)
            }`,
          );
        }
        if (!uri) {
          throw new Error('Recording could not be saved — no audio file was produced. Try recording again.');
        }

        durationSec = Math.max(
          1,
          Math.round((recording.currentTime * 1000 || Date.now() - startedAtRef.current) / 1000),
        );

        // expo-audio produces AAC in an MPEG-4 container on both iOS and Android.
        const shape = uploadShapeFor('audio/mp4');
        const fileRef = new ExpoFile(uri);
        byteSize = fileRef.exists ? fileRef.size : 0;
        assertUploadSize(byteSize, durationSec, await fetchMaxUploadBytes());
        formData.append('audio', fileRef, `recording.${shape.ext}`);
        formData.append('audioMimeType', shape.mime);
      } else {
        return;
      }

      formData.append('duration', String(durationSec));
      formData.append('clientTimestamp', startTimestampRef.current);

      const snapshot = await raceLocation(locationPromiseRef.current);
      locationPromiseRef.current = null;
      if (snapshot) {
        formData.append('lat', String(snapshot.coords.lat));
        formData.append('lng', String(snapshot.coords.lng));
        if (snapshot.placeName) formData.append('placeName', snapshot.placeName);
      }

      safeSetProgress(0.3);

      const controller = new AbortController();
      abortRef.current = controller;

      // No Content-Type header: the runtime must generate the multipart boundary.
      let uploadRes: Response;
      try {
        uploadRes = await fetch(apiUrl('/api/recordings/upload'), {
          method: 'POST',
          body: formData,
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(describeRequestError(err, 'Upload failed'));
      }

      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status}): ${await readError(uploadRes)}`);
      }

      const uploaded = (await uploadRes.json()) as UploadResponse;
      safeSetProgress(PROGRESS_BY_STATUS.uploaded);
      safeSetState('processing');

      await drivePipeline(uploaded.id, controller.signal, safeSetProgress);

      if (!mountedRef.current) return;
      setResult({ id: uploaded.id });
      setProgress(1);
      setState('done');

      autoResetTimerRef.current = setTimeout(() => {
        autoResetTimerRef.current = null;
        if (!mountedRef.current) return;
        setState((s) => (s === 'done' ? 'idle' : s));
        setProgress((p) => (p === 1 ? 0 : p));
      }, AUTO_RESET_MS);
    } catch (err) {
      await releaseIosRecordSession();
      if (mountedRef.current && !isAbort(err)) {
        setError(err instanceof Error ? err.message : 'Upload or processing failed');
        setState('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [safeSetProgress, safeSetState]);

  useEffect(() => {
    stopRef.current = () => {
      void stopAndUpload();
    };
  }, [stopAndUpload]);

  const reset = useCallback(async () => {
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    await teardownRecorder();
    await releaseIosRecordSession();
    locationPromiseRef.current = null;
    if (!mountedRef.current) return;
    setState('idle');
    setError(null);
    setResult(null);
    setProgress(0);
  }, [clearTimers, teardownRecorder]);

  return { state, error, result, progress, startRecording, stopAndUpload, reset };
}

// ─── Recording configuration ─────────────────────────────────────────────────

const RECORD_AUDIO_MODE = {
  allowsRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: 'doNotMix' as const,
};

const PLAYBACK_AUDIO_MODE = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: 'mixWithOthers' as const,
};

/**
 * Speech-grade AAC. Native only — web recording is driven directly by
 * lib/webRecorder.ts. expo-audio validates the android and ios blocks
 * even though only one of them applies to the running platform.
 */
function recordingOptions(): RecordingOptions {
  return {
    isMeteringEnabled: false,
    extension: '.m4a',
    sampleRate: 22050,
    numberOfChannels: 1,
    bitRate: 32000,
    android: {
      outputFormat: 'mpeg4' as const,
      audioEncoder: 'aac' as const,
    },
    ios: {
      outputFormat: IOSOutputFormat.MPEG4AAC,
      audioQuality: AudioQuality.MEDIUM,
      bitDepthHint: 16,
    },
    web: { bitsPerSecond: 32000 },
  };
}

/** Reverts the iOS audio session so playback returns to the loudspeaker. */
async function releaseIosRecordSession(): Promise<void> {
  try {
    await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
  } catch {
    // Session teardown must never mask the original failure.
  }
}

// ─── Upload helpers ──────────────────────────────────────────────────────────

function uploadShapeFor(rawMime: string): { ext: string; mime: string } {
  const shape = UPLOAD_SHAPE_BY_MIME[normalizeMime(rawMime)];
  if (shape) return shape;
  throw new Error(
    `Recorded audio is "${normalizeMime(rawMime) || 'unknown'}", which the transcription service does not accept. ` +
      'Supported: m4a/aac, ogg, wav, mp3.',
  );
}

function normalizeMime(rawMime: string): string {
  return (rawMime || '').split(';')[0].trim().toLowerCase();
}

/**
 * Returns the blob to upload. A recording already in a container Docling's ASR
 * pipeline reads is passed through untouched, keeping its compression; anything
 * else — in practice Chrome's WebM, which Docling classifies as video — is
 * decoded and re-encoded as 16 kHz mono WAV.
 */
async function prepareWebUpload(recorded: Blob): Promise<{ blob: Blob; ext: string; mime: string }> {
  const shape = UPLOAD_SHAPE_BY_MIME[normalizeMime(recorded.type)];
  if (shape) return { blob: recorded, ext: shape.ext, mime: shape.mime };

  const wav = await transcodeToWav(recorded);
  return { blob: wav.blob, ext: wav.ext, mime: wav.mime };
}

function assertUploadSize(bytes: number, durationSec: number, limit: number): void {
  if (bytes === 0) {
    throw new Error('The recording is empty — no audio was captured.');
  }
  if (bytes > limit) {
    throw new Error(
      `This ${Math.round(durationSec / 60)}-minute recording is ${(bytes / 1e6).toFixed(1)} MB, over the ${(
        limit / 1e6
      ).toFixed(1)} MB upload limit. Record shorter walks for now.`,
    );
  }
}

/**
 * The ceiling depends on where the API runs, not on the client, so it is read
 * from the server and cached. A failure here must not block an upload: the
 * server enforces the real limit and returns a 413 the client already surfaces.
 */
let cachedMaxUploadBytes: number | null = null;
async function fetchMaxUploadBytes(): Promise<number> {
  if (cachedMaxUploadBytes !== null) return cachedMaxUploadBytes;
  try {
    const res = await fetch(apiUrl('/api/recordings/upload'));
    if (res.ok) {
      const caps = (await res.json()) as { maxUploadBytes?: number };
      if (typeof caps.maxUploadBytes === 'number' && caps.maxUploadBytes > 0) {
        cachedMaxUploadBytes = caps.maxUploadBytes;
        return cachedMaxUploadBytes;
      }
    }
  } catch {
    // Offline or CORS-blocked: fall back and let the upload itself report it.
  }
  return FALLBACK_MAX_UPLOAD_BYTES;
}

async function raceLocation(
  pending: Promise<LocationSnapshot | null> | null,
): Promise<LocationSnapshot | null> {
  if (!pending) return null;
  return Promise.race([
    pending.catch(() => null),
    sleep(LOCATION_WAIT_MS).then(() => null),
  ]);
}

/**
 * Drives the server-side state machine. Each POST advances the job at most one
 * step and returns, so nothing here depends on background work surviving a
 * serverless invocation.
 */
async function drivePipeline(
  id: string,
  signal: AbortSignal,
  setProgress: (n: number) => void,
): Promise<void> {
  let delay = 1500;
  let consecutiveFailures = 0;
  const deadline = Date.now() + PROCESSING_DEADLINE_MS;

  while (Date.now() < deadline) {
    if (signal.aborted) return;

    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/recordings/${id}/process`), { method: 'POST', signal });
    } catch (err) {
      if (isAbort(err)) return;
      if (++consecutiveFailures >= 3) throw new Error(describeRequestError(err, 'Processing failed'));
      await sleep(delay);
      continue;
    }

    if (!res.ok) {
      if (res.status === 404) throw new Error('Recording not found on the server');
      if (++consecutiveFailures >= 3) {
        throw new Error(`Processing failed: HTTP ${res.status} ${await readError(res)}`);
      }
      await sleep(delay);
      continue;
    }

    consecutiveFailures = 0;
    const tick = (await res.json()) as ProcessResponse;
    setProgress(PROGRESS_BY_STATUS[tick.status] ?? 0.55);

    if (tick.status === 'failed') throw new Error(tick.error ?? 'Server-side processing failed');
    if (tick.status === 'ready') return;

    delay = Math.min(Math.max(tick.retryAfterMs, 1500), 8000);
    await sleep(delay);
  }

  throw new Error('Processing timed out — the recording is still on the server and will resume from the Recordings tab.');
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      return parsed.error ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return '';
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.message === 'Aborted');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
