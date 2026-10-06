import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { sweepOrphanedChunkFiles } from '../lib/chunkQueue';
import { apiUrl } from '../lib/api';
import {
  useFonts,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from '@expo-google-fonts/playfair-display';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
} from '@expo-google-fonts/inter';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
  });

  useEffect(() => {
    // One-time cleanup of .m4a chunk files left over from sessions before
    // per-chunk cleanup was added.
    sweepOrphanedChunkFiles();

    // Preflight warm-up ping: wake up hibernating Astra DB in background immediately on app launch
    try {
      void fetch(apiUrl('/api/health')).catch(() => {
        // Fire-and-forget; failure is handled on active screen queries
      });
    } catch {
      // Ignore if apiUrl throws due to unconfigured env on startup
    }
  }, []);

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="recording/[id]" options={{ presentation: 'card' }} />
        <Stack.Screen name="recording-chat" options={{ presentation: 'modal' }} />
        <Stack.Screen name="+not-found" />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}
