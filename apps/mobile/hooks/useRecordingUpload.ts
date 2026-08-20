/**
 * useRecordingUpload.ts
 *
 * Handles the full record → upload → poll-until-ready lifecycle.
 * Calls the useLocationPermission hook at record-start time.
 */

import { useState, useRef } from 'react';
import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { apiUrl } from '../lib/api';
import { useLocationPermission } from './useLocationPermission';

export type RecordState =
  | 'idle'
  | 'requesting'  // asking location permission
  | 'recording'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'error';

export interface UploadResult {
  id: string;
}

export function useRecordingUpload() {
  const [state, setState] = useState<RecordState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [progress, setProgress] = useState(0); // 0-1 for progress bar

  const recordingRef = useRef<Audio.Recording | null>(null);
  const startTimeRef = useRef<number>(0);
  const startTimestampRef = useRef<string>('');

  const { requestAndCapture } = useLocationPermission();

  async function startRecording() {
    try {
      setError(null);
      setResult(null);
      setState('requesting');

      // Request location permission + capture coords at record-start
      const locationSnap = await requestAndCapture();

      // Store location snapshot for use on stop
      locationSnapshotRef.current = locationSnap;
      startTimestampRef.current = new Date().toISOString();
      startTimeRef.current = Date.now();

      // Configure audio session
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );

      recordingRef.current = recording;
      setState('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setState('error');
    }
  }

  async function stopAndUpload() {
    const recording = recordingRef.current;
    if (!recording) return;

    try {
      setState('uploading');
      setProgress(0.1);

      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      recordingRef.current = null;

      if (!uri) throw new Error('No recording URI after stop');

      const durationSec = Math.round((Date.now() - startTimeRef.current) / 1000);
      const locationSnap = locationSnapshotRef.current;

      // On web, expo-av returns a blob: URI — fetch it directly to get a Blob.
      // On native, expo-file-system reads the file as base64 which we decode to a Blob,
      // because expo-file-system.readAsStringAsync is not available on web.
      let audioBlob: Blob;
      let audioFilename: string;
      if (Platform.OS === 'web') {
        const raw = await fetch(uri).then((r) => r.blob());
        // Browsers record as webm but Docling supports mp4 — re-wrap with mp4 MIME
        // and filename so the server and transcription pipeline treat it correctly.
        audioBlob = new Blob([raw], { type: 'video/mp4' });
        audioFilename = 'recording.mp4';
      } else {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const byteChars = atob(base64);
        const byteArr = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArr[i] = byteChars.charCodeAt(i);
        }
        audioBlob = new Blob([byteArr], { type: 'audio/m4a' });
        audioFilename = 'recording.m4a';
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, audioFilename);
      formData.append('duration', String(durationSec));
      formData.append('clientTimestamp', startTimestampRef.current);
      if (locationSnap) {
        formData.append('lat', String(locationSnap.coords.lat));
        formData.append('lng', String(locationSnap.coords.lng));
        if (locationSnap.placeName) {
          formData.append('placeName', locationSnap.placeName);
        }
      }

      setProgress(0.3);

      const uploadRes = await fetch(apiUrl('/api/recordings/upload'), {
        method: 'POST',
        body: formData,
      });

      if (!uploadRes.ok) {
        const body = await uploadRes.text();
        throw new Error(`Upload failed: ${uploadRes.status} ${body}`);
      }

      const { id } = (await uploadRes.json()) as { id: string };
      setProgress(0.5);
      setState('processing');

      // Poll until ready
      await pollUntilReady(id);

      setResult({ id });
      setProgress(1);
      setState('done');

      // Auto-reset to idle after 2s
      setTimeout(() => {
        setState('idle');
        setProgress(0);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload or processing failed');
      setState('error');
    }
  }

  async function pollUntilReady(id: string): Promise<void> {
    const INTERVAL = 3000;
    const TIMEOUT = 15 * 60 * 1000; // 15 minutes
    const deadline = Date.now() + TIMEOUT;
    let pollProgress = 0.5;

    while (Date.now() < deadline) {
      await sleep(INTERVAL);
      pollProgress = Math.min(pollProgress + 0.05, 0.95);
      setProgress(pollProgress);

      const res = await fetch(apiUrl(`/api/recordings/${id}`));
      if (!res.ok) continue;

      const doc = (await res.json()) as { status: string };
      if (doc.status === 'ready') return;
      if (doc.status === 'error') throw new Error('Server-side processing failed');
    }

    throw new Error('Processing timed out');
  }

  function reset() {
    setState('idle');
    setError(null);
    setResult(null);
    setProgress(0);
    locationSnapshotRef.current = null;
  }

  return { state, error, result, progress, startRecording, stopAndUpload, reset };
}

// Module-level ref — avoids stale closure in startRecording/stopAndUpload
const locationSnapshotRef = { current: null as import('./useLocationPermission').LocationSnapshot | null };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
