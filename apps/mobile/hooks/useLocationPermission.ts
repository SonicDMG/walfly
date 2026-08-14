/**
 * useLocationPermission.ts
 *
 * Requests location permission at record-start time (not on stop).
 * If permission is denied the hook returns null coords — recording proceeds normally.
 * Permission is requested once per mount; subsequent calls return cached state.
 */

import { useState, useRef } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';

export interface LocationSnapshot {
  coords: { lat: number; lng: number };
  placeName: string | null;
}

export interface LocationPermissionResult {
  /** Request location and capture coords. Call this at record-start. */
  requestAndCapture: () => Promise<LocationSnapshot | null>;
  /** Most recently captured snapshot, or null if not yet captured / denied. */
  snapshot: LocationSnapshot | null;
}

export function useLocationPermission(): LocationPermissionResult {
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const permissionAsked = useRef(false);

  async function requestAndCapture(): Promise<LocationSnapshot | null> {
    // Web: use browser Geolocation API
    if (Platform.OS === 'web') {
      return captureWeb();
    }

    // Native: request expo-location foreground permission
    if (!permissionAsked.current) {
      permissionAsked.current = true;
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.log('[location] Permission denied — recording without location');
        return null;
      }
    }

    return captureNative();
  }

  async function captureNative(): Promise<LocationSnapshot | null> {
    try {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const { latitude, longitude } = pos.coords;

      let placeName: string | null = null;
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
        if (place) {
          placeName = [place.name, place.city, place.region, place.country]
            .filter(Boolean)
            .join(', ');
        }
      } catch {
        // Reverse geocode is best-effort
      }

      const snap: LocationSnapshot = {
        coords: { lat: latitude, lng: longitude },
        placeName,
      };
      setSnapshot(snap);
      return snap;
    } catch (err) {
      console.warn('[location] captureNative failed:', err);
      return null;
    }
  }

  async function captureWeb(): Promise<LocationSnapshot | null> {
    if (!navigator?.geolocation) return null;

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude } = pos.coords;
          let placeName: string | null = null;

          try {
            const res = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
              { headers: { 'Accept-Language': 'en' } },
            );
            const data = (await res.json()) as { display_name?: string };
            placeName = data.display_name ?? null;
          } catch {
            // Reverse geocode is best-effort
          }

          const snap: LocationSnapshot = {
            coords: { lat: latitude, lng: longitude },
            placeName,
          };
          setSnapshot(snap);
          resolve(snap);
        },
        (err) => {
          console.log('[location] Web geolocation denied or failed:', err.message);
          resolve(null);
        },
        { timeout: 8000, maximumAge: 60_000 },
      );
    });
  }

  return { requestAndCapture, snapshot };
}
