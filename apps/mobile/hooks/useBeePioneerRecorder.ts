/**
 * useBeePioneerRecorder.ts
 *
 * Records from a Bee Pioneer wearable instead of the phone microphone, and
 * feeds the exact pipeline the phone recorder uses: live session on the
 * server → 15-second ADTS/AAC chunks through the shared chunkUploadQueue →
 * finalize → server-side pipeline driver (transcribe → enrich).
 *
 * The audio path is simple because the device already encodes AAC:
 *   notify payload → strip 2-byte header → ADTS frames → concatenate into a
 *   raw ADTS .aac file per chunk. A concatenated ADTS stream is a valid .aac
 *   file (that is what ADTS is for), ffmpeg reads it, and the API's sniffer
 *   recognizes the 0xFFF sync (see packages/api/lib/docling.ts).
 *
 * Nothing is decoded on the phone: no PCM, no re-encode, no battery cost.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import { File, Paths } from 'expo-file-system';
import { apiUrl, describeRequestError, type ProcessResponse } from '../lib/api';
import { chunkUploadQueue } from '../lib/chunkQueue';
import { BeePioneerConnection } from '../lib/beePioneer';
import {
  adtsSampleRate,
  concatBytes,
  type BeeBatteryState,
  type BeeFirmwareVersion,
} from '../lib/beeProtocol';

export type BeeRecordState =
  | 'idle'
  | 'connecting'
  | 'recording'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'error';

/** Matches the phone recorder's chunk cadence so both flows produce the same session shape. */
const CHUNK_INTERVAL_MS = 15000;
/** LC3-free AAC frames carry 1024 samples each; fall back to 16 kHz for duration math. */
const AAC_SAMPLES_PER_FRAME = 1024;
const FALLBACK_SAMPLE_RATE = 16000;
const MAX_RECORDING_MS = 15 * 60 * 1000;
const PROCESSING_DEADLINE_MS = 20 * 60 * 1000;

const PROGRESS_BY_STATUS: Record<string, number> = {
  uploaded: 0.55,
  transcribing: 0.7,
  enriching: 0.9,
  ready: 1,
  failed: 1,
};

/** Last successfully connected device id, for fast reconnects within an app run. */
let rememberedDeviceId: string | null = null;

export function useBeePioneerRecorder() {
  const [state, setState] = useState<BeeRecordState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [battery, setBattery] = useState<BeeBatteryState | null>(null);
  const [firmware, setFirmware] = useState<BeeFirmwareVersion | null>(null);

  const mountedRef = useRef(true);
  const managerRef = useRef<BleManager | null>(null);
  const connectionRef = useRef<BeePioneerConnection | null>(null);

  // Chunk accumulation state
  const pendingFramesRef = useRef<Uint8Array[]>([]);
  const pendingSamplesRef = useRef(0);
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const chunkIndexRef = useRef(0);
  const startedAtRef = useRef(0);
  const chunkStartRef = useRef(0);
  const stopRef = useRef<() => void>(() => undefined);

  const safeSetState = useCallback((next: BeeRecordState) => {
    if (mountedRef.current) setState(next);
  }, []);

  const safeSetProgress = useCallback((next: number) => {
    if (mountedRef.current) setProgress(next);
  }, []);

  const getManager = useCallback((): BleManager => {
    if (!managerRef.current) managerRef.current = new BleManager();
    return managerRef.current;
  }, []);

  const clearTimers = useCallback(() => {
    if (chunkTimerRef.current) {
      clearInterval(chunkTimerRef.current);
      chunkTimerRef.current = null;
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  /**
   * Writes the accumulated frames to a cache file and enqueues it. When the
   * window carried no frames at all, enqueues a silent marker so chunk indexes
   * and offsets still line up server-side.
   */
  const flushChunk = useCallback((): void => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;

    const frames = pendingFramesRef.current;
    pendingFramesRef.current = [];
    const samples = pendingSamplesRef.current;
    pendingSamplesRef.current = 0;

    const now = Date.now();
    const offsetMs = Math.max(0, chunkStartRef.current - startedAtRef.current);
    const windowMs = now - chunkStartRef.current;
    chunkStartRef.current = now;

    const chunkIndex = chunkIndexRef.current++;
    const durationSec = samples > 0
      ? samples / (adtsSampleRate(frames[0]) ?? FALLBACK_SAMPLE_RATE)
      : windowMs / 1000;

    if (frames.length === 0) {
      chunkUploadQueue.enqueue({
        recordingId: sessionId,
        chunkIndex,
        offsetMs,
        duration: Math.max(0.1, durationSec),
        silent: true,
        attempts: 0,
      });
      return;
    }

    try {
      const bytes = concatBytes(frames);
      const file = new File(Paths.cache, `bee-chunk-${chunkIndex}-${now}.aac`);
      file.create({ overwrite: true });
      file.write(bytes);

      chunkUploadQueue.enqueue({
        recordingId: sessionId,
        chunkIndex,
        offsetMs,
        duration: Math.max(0.1, durationSec),
        uri: file.uri,
        filename: `chunk-${chunkIndex}.aac`,
        attempts: 0,
      });
    } catch (err) {
      console.warn('[BeeRecorder] Failed to write chunk file:', err);
      chunkUploadQueue.enqueue({
        recordingId: sessionId,
        chunkIndex,
        offsetMs,
        duration: Math.max(0.1, durationSec),
        silent: true,
        attempts: 0,
      });
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (Platform.OS === 'web') {
      setError('The Bee Pioneer connects over BLE — recording from it requires the iOS or Android app.');
      setState('error');
      return;
    }

    clearTimers();
    safeSetState('connecting');
    setError(null);
    safeSetProgress(0);

    try {
      const bee = new BeePioneerConnection(getManager());
      connectionRef.current = bee;

      bee.onLog = (message) => console.log(message);
      bee.onDisconnect = () => {
        if (mountedRef.current) {
          void stopRef.current();
        }
      };
      bee.onAudioFrame = (frame) => {
        pendingFramesRef.current.push(frame);
        pendingSamplesRef.current += AAC_SAMPLES_PER_FRAME;
      };

      await bee.connect(rememberedDeviceId ?? undefined);
      rememberedDeviceId = bee.connectedDeviceId;

      void bee.queryFirmware().then((version) => {
        if (mountedRef.current && version) setFirmware(version);
      });
      void bee.queryBattery().then((batteryState) => {
        if (mountedRef.current && batteryState) setBattery(batteryState);
      });

      // Live session on the server, same contract as the phone recorder.
      const sessionId =
        globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `bee-${Date.now()}`;
      sessionIdRef.current = sessionId;
      chunkIndexRef.current = 0;
      startedAtRef.current = Date.now();
      chunkStartRef.current = startedAtRef.current;
      pendingFramesRef.current = [];
      pendingSamplesRef.current = 0;

      await fetch(apiUrl('/api/recordings/session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, createdAt: new Date().toISOString() }),
      });

      const acknowledged = await bee.startAudio();
      console.log(`[BeeRecorder] mic stream ${acknowledged ? 'acknowledged' : 'started (no ack)'}`);

      chunkTimerRef.current = setInterval(flushChunk, CHUNK_INTERVAL_MS);
      maxTimerRef.current = setTimeout(() => stopRef.current(), MAX_RECORDING_MS);

      safeSetState('recording');
    } catch (err) {
      await connectionRef.current?.disconnect().catch(() => undefined);
      connectionRef.current = null;
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to start Bee recording');
        setState('error');
      }
    }
  }, [clearTimers, flushChunk, getManager, safeSetProgress, safeSetState]);

  const stopAndUpload = useCallback(async () => {
    const bee = connectionRef.current;
    if (!bee || !sessionIdRef.current) return;

    clearTimers();

    try {
      safeSetState('uploading');
      safeSetProgress(0.1);

      await bee.stopAudio().catch(() => undefined);
      flushChunk();
      await bee.disconnect().catch(() => undefined);
      connectionRef.current = null;

      const sessionId = sessionIdRef.current;
      safeSetProgress(0.2);
      await chunkUploadQueue.drain();

      safeSetProgress(0.3);
      const durationSec = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
      const finalizeRes = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(sessionId)}/finalize`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalExpectedChunks: chunkIndexRef.current, duration: durationSec }),
      });
      if (!finalizeRes.ok) {
        throw new Error(`Session finalize failed (${finalizeRes.status})`);
      }
      sessionIdRef.current = null;

      safeSetProgress(PROGRESS_BY_STATUS.uploaded);
      safeSetState('processing');
      await drivePipeline(sessionId, safeSetProgress);

      if (!mountedRef.current) return;
      safeSetProgress(1);
      safeSetState('done');
      setTimeout(() => {
        if (mountedRef.current) {
          setState((s) => (s === 'done' ? 'idle' : s));
          setProgress((p) => (p === 1 ? 0 : p));
        }
      }, 2500);
    } catch (err) {
      await connectionRef.current?.disconnect().catch(() => undefined);
      connectionRef.current = null;
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Bee upload or processing failed');
        setState('error');
      }
    }
  }, [clearTimers, flushChunk, safeSetProgress, safeSetState]);

  useEffect(() => {
    stopRef.current = () => {
      void stopAndUpload();
    };
  }, [stopAndUpload]);

  const reset = useCallback(async () => {
    clearTimers();
    await connectionRef.current?.disconnect().catch(() => undefined);
    connectionRef.current = null;
    sessionIdRef.current = null;
    pendingFramesRef.current = [];
    pendingSamplesRef.current = 0;
    if (!mountedRef.current) return;
    setState('idle');
    setError(null);
    setProgress(0);
  }, [clearTimers]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimers();
      void connectionRef.current?.disconnect().catch(() => undefined);
      managerRef.current?.destroy();
      managerRef.current = null;
    };
  }, [clearTimers]);

  const refreshBattery = useCallback(async () => {
    const bee = connectionRef.current;
    if (!bee) return;
    const batteryState = await bee.queryBattery();
    if (mountedRef.current && batteryState) setBattery(batteryState);
  }, []);

  return {
    state,
    error,
    progress,
    battery,
    firmware,
    startRecording,
    stopAndUpload,
    reset,
    refreshBattery,
  };
}

/**
 * Drives the server-side state machine, one tick at a time (the same
 * contract useRecordingUpload.drivePipeline uses; kept local so the two
 * hooks stay independently testable).
 */
async function drivePipeline(id: string, setProgress: (n: number) => void): Promise<void> {
  let delay = 1500;
  let consecutiveFailures = 0;
  const deadline = Date.now() + PROCESSING_DEADLINE_MS;

  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/recordings/${id}/process`), { method: 'POST' });
    } catch (err) {
      if (++consecutiveFailures >= 3) throw new Error(describeRequestError(err, 'Processing failed'));
      await sleep(delay);
      continue;
    }

    if (!res.ok) {
      if (res.status === 404) throw new Error('Recording not found on the server');
      if (++consecutiveFailures >= 3) throw new Error(`Processing failed: HTTP ${res.status}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}