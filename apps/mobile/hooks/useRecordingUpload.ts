/**
 * useRecordingUpload.ts
 *
 * The full record → stream → finalize → drive-the-pipeline lifecycle.
 *
 * Contract this file enforces, and why each part exists:
 *   - Audio streams continuously from the microphone to the ASR sidecar over
 *     one WebSocket; the sidecar owns VAD, chunking and transcription (see
 *     streaming-plan.md at the repo root). Nothing is encoded, chunked or
 *     silence-gated on the client.
 *   - Web capture is an AudioWorklet Float32 tap (lib/webMic.ts); native
 *     capture is expo-audio's AudioStream (int16 PCM). Both feed the same
 *     100 ms frame batcher (lib/pcm.ts) and the same client (lib/streamClient.ts).
 *   - The session document is created before the socket opens; finalized
 *     segments are checkpointed through POST /api/recordings/{id}/segments and
 *     acked to the sidecar only after that write succeeds — acked means
 *     durable in Astra.
 *   - Microphone permission is requested on every platform before recording,
 *     and the iOS audio session is switched into record mode and back out, so
 *     later playback is not routed to the earpiece.
 *   - Location never delays recording: capture starts immediately and the
 *     resolved place is patched onto the session when it arrives.
 *   - Nothing runs in the background on the server: this hook drives
 *     POST /api/recordings/{id}/process until the recording is ready.
 *   - Every timer, capture handle and in-flight request is torn down on
 *     unmount, and no state is set afterwards.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
  type AudioStreamBuffer,
} from 'expo-audio';
import {
  apiUrl,
  describeRequestError,
  fetchWsTicket,
  postSegment,
  type ProcessResponse,
  type RecordingStatus,
} from '../lib/api';
import { useLocationPermission, type LocationSnapshot } from './useLocationPermission';
import { createFrameBatcher, type FrameBatcher } from '../lib/pcm';
// Web-only in practice; every browser API reference inside is guarded at call time.
import { startWebMic, type WebMicHandle } from '../lib/webMic';
import {
  AudioStreamClient,
  type StreamConnectionState,
  type StreamSegment,
} from '../lib/streamClient';

const ACTIVE_SESSION_STORAGE_KEY = 'walfly_active_recording_session';

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

/** Below this, no usable audio has been captured; Android can also drop the first frames. */
const MIN_RECORDING_MS = 1200;
/** Hard stop, so a forgotten recorder cannot run forever. */
const MAX_RECORDING_MS = 15 * 60 * 1000;
/** Give up on the server-side pipeline after this long. */
const PROCESSING_DEADLINE_MS = 20 * 60 * 1000;
const AUTO_RESET_MS = 2000;
/** How much live text the UI keeps for display. */
const LIVE_TRANSCRIPT_MAX_CHARS = 1200;
/** Frames captured before the socket is ready (worst case ~2 s). */
const PREROLL_MAX_FRAMES = 20;

const PROGRESS_BY_STATUS: Record<RecordingStatus, number> = {
  recording: 0.2,
  uploaded: 0.55,
  transcribing: 0.7,
  enriching: 0.9,
  ready: 1,
  failed: 1,
};

export function useRecordingUpload() {
  const [state, setState] = useState<RecordState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState(0);
  /** Growing live text: finalized segments plus the current partial. */
  const [liveTranscript, setLiveTranscript] = useState('');
  const [streamState, setStreamState] = useState<StreamConnectionState | 'idle'>('idle');

  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const clientRef = useRef<AudioStreamClient | null>(null);
  const batcherRef = useRef<FrameBatcher | null>(null);
  const webMicRef = useRef<WebMicHandle | null>(null);
  const startedAtRef = useRef(0);
  const autoResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  // Live text assembly (refs so the stream callbacks never close over stale state).
  const finalizedTextRef = useRef('');
  const partialTextRef = useRef('');
  const postedSegmentsRef = useRef(0);
  // Frames captured before the stream client is ready are held briefly, then flushed.
  const prerollRef = useRef<Int16Array[] | null>(null);
  // Native capture flag: buffers arriving outside a recording are ignored.
  const nativeActiveRef = useRef(false);

  const { requestAndCapture } = useLocationPermission();

  const safeSetState = useCallback((next: RecordState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const safeSetProgress = useCallback((next: number) => {
    if (mountedRef.current) setProgress(next);
  }, []);

  const publishLiveText = useCallback(() => {
    if (!mountedRef.current) return;
    const text = `${finalizedTextRef.current} ${partialTextRef.current}`.trim();
    setLiveTranscript(text.length > LIVE_TRANSCRIPT_MAX_CHARS ? text.slice(-LIVE_TRANSCRIPT_MAX_CHARS) : text);
  }, []);

  /** Single entry point for every captured frame, from either platform. */
  const handleFrameRef = useRef<(frame: Int16Array) => void>(() => undefined);
  handleFrameRef.current = (frame: Int16Array) => {
    const client = clientRef.current;
    if (client) {
      client.push(frame);
      return;
    }
    const preroll = prerollRef.current;
    if (preroll && preroll.length < PREROLL_MAX_FRAMES) preroll.push(frame);
  };

  const pushSamples = useCallback((push: (batcher: FrameBatcher) => void, sampleRate: number) => {
    let batcher = batcherRef.current;
    if (!batcher || batcher.sampleRate !== sampleRate) {
      batcher = createFrameBatcher({
        sampleRate,
        onFrame: (frame) => handleFrameRef.current(frame),
      });
      batcherRef.current = batcher;
    }
    push(batcher);
  }, []);

  // Native capture uses expo-audio's AudioStream (web returns null; the web
  // path captures through lib/webMic.ts instead). The hook is called
  // unconditionally to obey the rules of hooks.
  const nativeStream = useAudioStream({
    sampleRate: 16000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (buffer: AudioStreamBuffer) => {
      if (!nativeActiveRef.current) return;
      const rate = buffer.sampleRate || 16000;
      pushSamples((batcher) => batcher.pushInt16(new Int16Array(buffer.data)), rate);
    },
  });

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

  /** Stops and removes any live capture and stream client. Never throws. */
  const teardownCapture = useCallback(async () => {
    const webMic = webMicRef.current;
    webMicRef.current = null;
    if (webMic) {
      try {
        batcherRef.current?.flushPartial();
      } catch {}
      webMic.stop();
    }
    if (nativeActiveRef.current) {
      nativeActiveRef.current = false;
      try {
        nativeStream.stream.stop();
      } catch {
        // Already stopped.
      }
    }
    const client = clientRef.current;
    clientRef.current = null;
    if (client) {
      try {
        client.close();
      } catch {}
    }
    batcherRef.current = null;
    prerollRef.current = null;
  }, [nativeStream]);

  // ── crash recovery + teardown ─────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    // A session id left in storage means the app died mid-recording. Segments
    // already checkpointed are durable; finalize flips the session so the
    // pipeline can enrich whatever arrived.
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        const orphanSessionId = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
        if (orphanSessionId) {
          console.log(`[Crash Recovery] Found orphaned session: ${orphanSessionId}. Finalizing...`);
          void fetch(apiUrl(`/api/recordings/${encodeURIComponent(orphanSessionId)}/finalize`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }).finally(() => {
            try {
              window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
            } catch {}
          });
        }
      } catch {}
    }

    return () => {
      mountedRef.current = false;
      clearTimers();
      abortRef.current?.abort();
      abortRef.current = null;
      void teardownCapture().then(releaseIosRecordSession);
    };
  }, [clearTimers, teardownCapture]);

  // ── start ─────────────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;

    try {
      setError(null);
      setResult(null);
      finalizedTextRef.current = '';
      partialTextRef.current = '';
      postedSegmentsRef.current = 0;
      safeSetProgress(0);
      safeSetState('requesting');

      await teardownCapture();

      const mic = await requestRecordingPermissionsAsync();
      if (!mic.granted) {
        throw new Error(
          'Microphone permission denied. Enable microphone access for Walfly in your system settings.',
        );
      }

      const startedAt = Date.now();
      startedAtRef.current = startedAt;
      prerollRef.current = [];

      // 1. Start capture first so the real sample rate is known before hello.
      let sampleRate = 16000;
      if (Platform.OS === 'web') {
        webMicRef.current = await startWebMic({
          onSamples: (samples, rate) => pushSamples((batcher) => batcher.pushFloat32(samples), rate),
        });
        sampleRate = webMicRef.current.sampleRate;
      } else {
        await setAudioModeAsync(RECORD_AUDIO_MODE);
        nativeActiveRef.current = true;
        await nativeStream.stream.start();
        sampleRate = nativeStream.stream.sampleRate || 16000;
      }

      // 2. Session document, then a ticket for the audio socket.
      const sessionId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `rec-${Date.now()}`;
      sessionIdRef.current = sessionId;
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
        } catch {}
      }

      const sessionRes = await fetch(apiUrl('/api/recordings/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, createdAt: new Date(startedAt).toISOString() }),
      });
      if (!sessionRes.ok) {
        throw new Error(`Could not start the recording session (${sessionRes.status})`);
      }

      // 3. Location never delays the stream: patch it in when it resolves.
      void requestAndCapture().then((snapshot) => patchLocation(sessionId, snapshot));

      // 4. Audio socket. Frames captured up to this point are flushed from the
      //    pre-roll buffer once the handshake completes.
      const client = await AudioStreamClient.open({
        sessionId,
        sampleRate,
        getTicket: () => fetchWsTicket(sessionId),
        onPartial: (partial) => {
          partialTextRef.current = partial.text;
          publishLiveText();
        },
        onSegment: async (segment: StreamSegment) => {
          await postSegment(sessionId, {
            chunkIndex: segment.chunkIndex,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text,
          });
          postedSegmentsRef.current += 1;
          finalizedTextRef.current = `${finalizedTextRef.current} ${segment.text}`.trim();
          partialTextRef.current = '';
          publishLiveText();
        },
        onState: (next, detail) => {
          if (mountedRef.current) setStreamState(next);
          if (next === 'failed' && detail) {
            console.warn(`[Stream] degraded: ${detail}`);
          }
        },
        onGap: (fromMs, toMs) => {
          console.warn(`[Stream] audio gap ${fromMs}–${toMs} ms`);
        },
      });
      clientRef.current = client;

      const preroll = prerollRef.current;
      prerollRef.current = null;
      if (preroll) {
        for (const frame of preroll) client.push(frame);
      }

      safeSetState('recording');

      maxDurationTimerRef.current = setTimeout(() => {
        maxDurationTimerRef.current = null;
        stopRef.current();
      }, MAX_RECORDING_MS);
    } catch (err) {
      await teardownCapture();
      await releaseIosRecordSession();
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to start recording');
        setState('error');
      }
    }
  }, [clearTimers, nativeStream, publishLiveText, pushSamples, requestAndCapture, safeSetProgress, safeSetState, teardownCapture]);

  // ── stop ──────────────────────────────────────────────────────────────────

  const stopAndUpload = useCallback(async () => {
    // Claimed synchronously: a double tap or the MAX_RECORDING_MS timer can
    // both land before React commits the 'uploading' state.
    const client = clientRef.current;
    const webMic = webMicRef.current;
    const wasNative = nativeActiveRef.current;
    if (!client && !webMic && !wasNative) return;
    clientRef.current = null;
    webMicRef.current = null;
    nativeActiveRef.current = false;

    clearTimers();

    try {
      safeSetState('uploading');
      safeSetProgress(0.1);

      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed < MIN_RECORDING_MS) await sleep(MIN_RECORDING_MS - elapsed);

      // Stop capture before the socket so the tail frame is enqueued first.
      batcherRef.current?.flushPartial();
      batcherRef.current = null;
      if (webMic) webMic.stop();
      if (wasNative) {
        try {
          nativeStream.stream.stop();
        } catch {}
      }
      await releaseIosRecordSession();

      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        throw new Error('Recording session was not created — nothing to finalize.');
      }
      const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));

      // `stop()` sends bye and waits for the sidecar's final flush; pending
      // segment checkpoints are drained inside.
      safeSetProgress(0.2);
      if (client) await client.stop();

      safeSetProgress(0.3);
      const controller = new AbortController();
      abortRef.current = controller;
      const finRes = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(sessionId)}/finalize`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: durationSec }),
      });
      if (!finRes.ok) {
        throw new Error(`Session finalize failed (${finRes.status}): ${await readError(finRes)}`);
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
        } catch {}
      }
      sessionIdRef.current = null;

      safeSetProgress(PROGRESS_BY_STATUS.uploaded);
      safeSetState('processing');

      await drivePipeline(sessionId, controller.signal, safeSetProgress);

      if (!mountedRef.current) return;
      setResult({ id: sessionId });
      setProgress(1);
      setState('done');

      autoResetTimerRef.current = setTimeout(() => {
        autoResetTimerRef.current = null;
        if (!mountedRef.current) return;
        setState((s) => (s === 'done' ? 'idle' : s));
        setProgress((p) => (p === 1 ? 0 : p));
        setLiveTranscript('');
        setStreamState('idle');
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
  }, [clearTimers, nativeStream, safeSetProgress, safeSetState]);

  useEffect(() => {
    stopRef.current = () => {
      void stopAndUpload();
    };
  }, [stopAndUpload]);

  const reset = useCallback(async () => {
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    await teardownCapture();
    await releaseIosRecordSession();
    sessionIdRef.current = null;
    finalizedTextRef.current = '';
    partialTextRef.current = '';
    if (!mountedRef.current) return;
    setState('idle');
    setError(null);
    setResult(null);
    setProgress(0);
    setLiveTranscript('');
    setStreamState('idle');
  }, [clearTimers, teardownCapture]);

  return {
    state,
    error,
    result,
    progress,
    liveTranscript,
    streamState,
    startRecording,
    stopAndUpload,
    reset,
  };
}

// ─── Audio session configuration ─────────────────────────────────────────────

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

/** Reverts the iOS audio session so playback returns to the loudspeaker. */
async function releaseIosRecordSession(): Promise<void> {
  try {
    await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
  } catch {
    // Session teardown must never mask the original failure.
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Best-effort: the location snapshot resolves after capture has started, so it
 * is patched onto the session instead of delaying it. A failure here must
 * never surface as a recording error.
 */
async function patchLocation(sessionId: string, snapshot: LocationSnapshot | null): Promise<void> {
  if (!snapshot) return;
  const body: Record<string, number | string> = {
    lat: snapshot.coords.lat,
    lng: snapshot.coords.lng,
  };
  if (snapshot.placeName) body.placeName = snapshot.placeName;
  try {
    await fetch(apiUrl(`/api/recordings/${encodeURIComponent(sessionId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[Location] Could not patch session location:', err);
  }
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
