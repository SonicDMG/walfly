/**
 * useLocationPermission.ts
 *
 * Best-effort location capture for a recording. Location is optional metadata,
 * so every path here is bounded and non-throwing: the caller fires it
 * concurrently with the recorder and races it against a short timeout, and a
 * denial or a missing GPS fix simply yields `null`.
 *
 * The permission STATUS is cached (not an "already asked" boolean), so a denial
 * short-circuits immediately instead of paying an unbounded native call on
 * every subsequent recording.
 *
 * Reverse geocoding on web is deliberately absent: browsers cannot set a
 * User-Agent, so a direct Nominatim call is rate-limited to failure and only
 * adds latency. Native uses the OS geocoder, which has no such constraint.
 */

import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';

export interface LocationSnapshot {
  coords: { lat: number; lng: number };
  placeName: string | null;
}

export interface LocationPermissionResult {
  /** Capture coords. Never rejects; resolves to null when unavailable. */
  requestAndCapture: () => Promise<LocationSnapshot | null>;
  /** Most recently captured snapshot, or null if not yet captured / denied. */
  snapshot: LocationSnapshot | null;
}

/** Upper bound on the OS reverse-geocode lookup. */
const GEOCODE_TIMEOUT_MS = 3000;
/** Upper bound on acquiring a position fix. */
const POSITION_TIMEOUT_MS = 6000;

type PermissionStatus = 'undetermined' | 'granted' | 'denied';

export function useLocationPermission(): LocationPermissionResult {
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const statusRef = useRef<PermissionStatus>('undetermined');

  const requestAndCapture = useCallback(async (): Promise<LocationSnapshot | null> => {
    try {
      if (Platform.OS === 'web') {
        const snap = await captureWeb();
        if (snap) setSnapshot(snap);
        return snap;
      }

      if (statusRef.current === 'denied') return null;

      if (statusRef.current === 'undetermined') {
        const current = await Location.getForegroundPermissionsAsync();
        if (current.status === 'granted') {
          statusRef.current = 'granted';
        } else if (current.canAskAgain === false) {
          statusRef.current = 'denied';
          return null;
        } else {
          const requested = await Location.requestForegroundPermissionsAsync();
          statusRef.current = requested.status === 'granted' ? 'granted' : 'denied';
          if (statusRef.current === 'denied') {
            console.log('[location] Permission denied — recording without location');
            return null;
          }
        }
      }

      const snap = await captureNative();
      if (snap) setSnapshot(snap);
      return snap;
    } catch (err) {
      console.warn('[location] capture failed:', err);
      return null;
    }
  }, []);

  return { requestAndCapture, snapshot };
}

/** Resolves to `null` instead of rejecting once `ms` elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function captureNative(): Promise<LocationSnapshot | null> {
  const pos = await withTimeout(
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    POSITION_TIMEOUT_MS,
  );
  if (!pos) return null;

  const { latitude, longitude } = pos.coords;

  const places = await withTimeout(
    Location.reverseGeocodeAsync({ latitude, longitude }),
    GEOCODE_TIMEOUT_MS,
  );
  const place = places?.[0];
  const placeName = place
    ? [place.name, place.city, place.region, place.country].filter(Boolean).join(', ') || null
    : null;

  return { coords: { lat: latitude, lng: longitude }, placeName };
}

async function captureWeb(): Promise<LocationSnapshot | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          placeName: null,
        });
      },
      (err) => {
        console.log('[location] Web geolocation denied or failed:', err.message);
        resolve(null);
      },
      { timeout: POSITION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}
