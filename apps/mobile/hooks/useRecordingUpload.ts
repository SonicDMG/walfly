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
import {
  createLocalBuffer,
  listPendingBuffers,
  openExistingBuffer,
  type LocalBuffer,
} from '../lib/localBuffer';
import { deliverLocalBuffer } from '../lib/recoverClient';

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
  const [streamState, setStreamState] = useState<StreamConnectionState | 'idle' | 'offline'>('idle');

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
  // True from the moment capture+stream are live until a stop is claimed;
  // drives the "sidecar ended the session" path.
  const recordingActiveRef = useRef(false);
  // The crash-safe local copy of every frame (null when the platform cannot
  // buffer; behaviour then falls back to the streaming-only path).
  const bufferRef = useRef<LocalBuffer | null>(null);
  // True while the live stream is detached (sidecar unreachable, or the server
  // ended the session): capture continues and the buffer is the safety net.
  const streamLostRef = useRef(false);
  // Guards stopAndUpload against re-entry without losing the tail flush.
  const stoppingRef = useRef(false);

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

  /**
   * Opens one audio socket. Extracted so both the initial start and the
   * server-ended path ("open a fresh server session and keep going") share it.
   * Assigned every render to capture fresh closures.
   */
  const openClientRef = useRef<(sessionId: string, sampleRate: number) => Promise<AudioStreamClient>>(
    async () => {
      throw new Error('client factory not ready');
    },
  );
  openClientRef.current = (sessionId: string, sampleRate: number) =>
    AudioStreamClient.open({
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
        if (next === 'live') streamLostRef.current = false;
        if (mountedRef.current) setStreamState(next);
        if (next === 'failed' && detail) {
          console.warn(`[Stream] degraded: ${detail}`);
        }
      },
      onGap: (fromMs, toMs) => {
        console.warn(`[Stream] audio gap ${fromMs}–${toMs} ms`);
      },
      onEnded: () => {
        // The sidecar ended the session by itself (idle timeout, capacity,
        // max duration, deploy). Keep recording: the local buffer already
        // holds the audio, and we try once to open a fresh server session so
        // live transcription resumes. Everything already checkpointed is
        // durable; nothing here may throw into the capture path.
        console.warn('[Stream] the sidecar ended the session; continuing locally');
        streamLostRef.current = true;
        if (mountedRef.current) setStreamState('offline');
        const previous = clientRef.current;
        void (async () => {
          try {
            const replacement = await openClientRef.current(sessionId, sampleRate);
            if (recordingActiveRef.current && clientRef.current === previous) {
              clientRef.current = replacement;
              streamLostRef.current = false;
              if (mountedRef.current) setStreamState('live');
            } else {
              replacement.close();
            }
          } catch (err) {
            console.warn('[Stream] could not re-attach; staying local:', err);
          }
        })();
      },
    });

  /** Single entry point for every captured frame, from either platform. */
  const handleFrameRef = useRef<(frame: Int16Array) => void>(() => undefined);
  handleFrameRef.current = (frame: Int16Array) => {
    const client = clientRef.current;
    if (client) {
      client.push(frame);
    } else {
      const preroll = prerollRef.current;
      if (preroll && preroll.length < PREROLL_MAX_FRAMES) preroll.push(frame);
    }
    // Tee into the crash-safe local copy. Both consumers copy the frame before
    // it can be reused, so the order here is not load-bearing; the cost is
    // ~3.2 KB at 10 Hz and the call can never throw.
    bufferRef.current?.append(frame);
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
    // The buffer is deliberately NOT discarded here: an unmount keeps the
    // recording, and the launch sweep delivers it. Finalizing patches the WAV
    // header and releases the exclusive file lock so a later sweep can open it.
    const buffer = bufferRef.current;
    bufferRef.current = null;
    if (buffer) {
      void buffer.finalize().catch(() => {});
    }
  }, [nativeStream]);

  // ── crash recovery + teardown ─────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;

    // Crash recovery: deliver what the local buffers hold, then heal the legacy
    // orphan marker. A buffer that cannot be delivered yet stays on disk and is
    // retried on the next launch and on the next recorder reset.
    void (async () => {
      let pendingIds: string[] = [];
      try {
        pendingIds = await listPendingBuffers();
      } catch {}
      const delivered = new Set<string>();
      for (const id of pendingIds) {
        if (await deliverOneBuffer(id)) delivered.add(id);
      }

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          const orphanSessionId = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
          const stillPending =
            orphanSessionId !== null && pendingIds.includes(orphanSessionId) && !delivered.has(orphanSessionId);
          if (orphanSessionId && !stillPending) {
            console.log(`[Crash Recovery] Finalizing orphaned session ${orphanSessionId}`);
            await fetch(apiUrl(`/api/recordings/${encodeURIComponent(orphanSessionId)}/finalize`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            }).catch(() => {});
            window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
          }
        } catch {}
      }
    })();

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
      stoppingRef.current = false;
      streamLostRef.current = false;
      prerollRef.current = [];

      // 1. The session id first: the server document and the local buffer share
      //    it, which is what lets a later sweep join a crash's audio to its doc.
      const sessionId = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `rec-${Date.now()}`;
      sessionIdRef.current = sessionId;
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
        } catch {}
      }

      // 2. Capture first so the real sample rate is known before hello.
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

      // 3. Crash-safe local buffer, created before anything else can fail: from
      //    here on every frame lands on disk even if the sidecar or the API is
      //    gone. If the platform cannot buffer, streaming alone still works.
      let buffer: LocalBuffer | null = null;
      try {
        buffer = await createLocalBuffer(sessionId);
      } catch (err) {
        console.warn('[LocalBuffer] unavailable; streaming only:', err);
      }
      bufferRef.current = buffer;

      // 4. Session document.
      const sessionRes = await fetch(apiUrl('/api/recordings/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, createdAt: new Date(startedAt).toISOString() }),
      });
      if (!sessionRes.ok) {
        throw new Error(`Could not start the recording session (${sessionRes.status})`);
      }

      // 5. Location never delays the stream: patch it in when it resolves.
      void requestAndCapture().then((snapshot) => patchLocation(sessionId, snapshot));

      // 6. Audio socket. Frames captured up to this point are flushed from the
      //    pre-roll buffer once the handshake completes. When the sidecar is
      //    unreachable and a local buffer exists, recording simply continues
      //    locally and the buffer is delivered later.
      let client: AudioStreamClient | null = null;
      try {
        client = await openClientRef.current(sessionId, sampleRate);
      } catch (err) {
        if (!buffer) throw err;
        streamLostRef.current = true;
        console.warn('[Stream] sidecar unreachable; recording locally:', err);
      }
      clientRef.current = client;
      if (mountedRef.current) setStreamState(client ? 'live' : 'offline');

      const preroll = prerollRef.current;
      prerollRef.current = null;
      if (preroll && client) {
        for (const frame of preroll) client.push(frame);
      }

      recordingActiveRef.current = true;
      safeSetState('recording');

      maxDurationTimerRef.current = setTimeout(() => {
        maxDurationTimerRef.current = null;
        stopRef.current();
      }, MAX_RECORDING_MS);
    } catch (err) {
      recordingActiveRef.current = false;
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
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    recordingActiveRef.current = false;

    const client = clientRef.current;
    const webMic = webMicRef.current;
    const wasNative = nativeActiveRef.current;
    const buffer = bufferRef.current;
    if (!client && !webMic && !wasNative) {
      stoppingRef.current = false;
      return;
    }

    clearTimers();

    try {
      safeSetState('uploading');
      safeSetProgress(0.1);

      const elapsed = Date.now() - startedAtRef.current;
      if (elapsed < MIN_RECORDING_MS) await sleep(MIN_RECORDING_MS - elapsed);

      // Flush the tail while the refs still point at the live sinks, then stop
      // capture and release everything.
      batcherRef.current?.flushPartial();
      batcherRef.current = null;
      if (webMic) webMic.stop();
      if (wasNative) {
        try {
          nativeStream.stream.stop();
        } catch {}
      }
      await releaseIosRecordSession();

      clientRef.current = null;
      webMicRef.current = null;
      nativeActiveRef.current = false;
      bufferRef.current = null;
      prerollRef.current = null;

      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        throw new Error('Recording session was not created — nothing to finalize.');
      }
      const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      const hasTranscript = postedSegmentsRef.current > 0;

      // `stop()` sends bye and waits for the sidecar's final flush; pending
      // segment checkpoints are drained inside.
      safeSetProgress(0.2);
      if (client) await client.stop();

      // Deliver the crash-safe local copy: always the audio archive, and the
      // transcript source whenever the stream was incomplete or never attached
      // (chooseTranscriptSource on the server decides which).
      let delivered = false;
      if (buffer) {
        safeSetProgress(0.25);
        try {
          const file = await buffer.finalize();
          if (file.bytes > 44 && file.durationSec >= 0.5) {
            const gapMs = client ? (client.unackedFrames + client.droppedFrames) * 100 : null;
            const result = await deliverLocalBuffer({
              recordingId: sessionId,
              buffer,
              file,
              gapMs,
              prefer: 'auto',
              createdAt: new Date(startedAtRef.current).toISOString(),
            });
            if (result.status === 'delivered' || result.status === 'already' || result.status === 'skipped') {
              delivered = true;
              await buffer.discard().catch(() => {});
            } else {
              console.warn(`[Recovery] delivery deferred (${result.error ?? 'unknown'}); buffer kept`);
            }
          } else {
            await buffer.discard().catch(() => {});
          }
        } catch (err) {
          console.warn('[Recovery] delivery failed; buffer kept:', err);
        }
      }

      const controller = new AbortController();
      abortRef.current = controller;

      if (!delivered) {
        if (!hasTranscript) {
          // Nothing durable exists yet: do not finalize into an empty
          // recording. The buffer stays on this device and the sweep retries.
          throw new Error(
            'Recording saved on this device — it will sync automatically when the connection returns.',
          );
        }
        safeSetProgress(0.3);
        const finRes = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(sessionId)}/finalize`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: durationSec }),
        });
        if (!finRes.ok) {
          throw new Error(`Session finalize failed (${finRes.status}): ${await readError(finRes)}`);
        }
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
      stoppingRef.current = false;
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
    // Retry any delivery that was deferred while offline.
    void sweepPendingBuffers();
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

// ─── Local-buffer sweep ──────────────────────────────────────────────────────
// Deliver whatever a crash or an offline session left in the local buffer.
// Only server-confirmed deliveries delete the buffer; everything else is left
// for the next launch (or the next recorder reset).

async function sweepPendingBuffers(): Promise<void> {
  let ids: string[] = [];
  try {
    ids = await listPendingBuffers();
  } catch (err) {
    console.warn('[Recovery] could not list local buffers:', err);
    return;
  }
  for (const id of ids) {
    await deliverOneBuffer(id);
  }
}

async function deliverOneBuffer(recordingId: string): Promise<boolean> {
  try {
    const buffer = await openExistingBuffer(recordingId);
    const file = await buffer.finalize();
    if (file.bytes <= 44 || file.durationSec < 0.5) {
      // Header only — a start that never captured.
      await buffer.discard().catch(() => {});
      return true;
    }
    const result = await deliverLocalBuffer({
      recordingId,
      buffer,
      file,
      gapMs: null, // unknown after a crash: the server prefers the full file
      prefer: 'auto',
    });
    if (result.status === 'delivered' || result.status === 'already' || result.status === 'skipped') {
      await buffer.discard().catch(() => {});
      void tickPipelineOnce(recordingId);
      return true;
    }
    console.warn(`[Recovery] ${recordingId}: delivery deferred (${result.error ?? 'unknown'})`);
    return false;
  } catch (err) {
    console.warn(`[Recovery] ${recordingId}: not deliverable yet:`, err);
    return false;
  }
}

/** A nudge; the Recordings list ticks non-terminal rows anyway. */
async function tickPipelineOnce(recordingId: string): Promise<void> {
  try {
    await fetch(apiUrl(`/api/recordings/${encodeURIComponent(recordingId)}/process`), { method: 'POST' });
  } catch {
    // Best effort.
  }
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
