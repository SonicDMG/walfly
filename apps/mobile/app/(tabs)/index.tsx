/**
 * Tab 1 — Record Screen
 *
 * Dark-first. Minimal. A single confident button.
 * Amber on Midnight — "the moments you were there for."
 */

import { useRef, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
} from 'react-native';
import * as Progress from 'react-native-progress';
import { useRecordingUpload, RecordState } from '../../hooks/useRecordingUpload';
import { colors, fonts, fontSizes, spacing, radius, shadow } from '../../lib/theme';

const BUSY_STATES = new Set<RecordState>(['uploading', 'processing', 'requesting']);

export default function RecordScreen() {
  const { state, error, progress, startRecording, stopAndUpload, reset } =
    useRecordingUpload();

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim  = useRef(new Animated.Value(0)).current;

  // Pulse + glow while recording
  useEffect(() => {
    if (state === 'recording') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.7, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1,   duration: 800, useNativeDriver: true }),
        ]),
      );
      const glow = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0, duration: 800, useNativeDriver: true }),
        ]),
      );
      pulse.start();
      glow.start();
      return () => { pulse.stop(); glow.stop(); pulseAnim.setValue(1); glowAnim.setValue(0); };
    }
    pulseAnim.setValue(BUSY_STATES.has(state) ? 0.5 : 1);
    glowAnim.setValue(0);
  }, [state, pulseAnim, glowAnim]);

  function handlePress() {
    if (state === 'recording') { void stopAndUpload(); return; }
    if (state === 'idle' || state === 'error' || state === 'done') {
      void (async () => {
        if (state === 'error' || state === 'done') await reset();
        await startRecording();
      })();
    }
  }

  const isRecording = state === 'recording';
  const isBusy      = BUSY_STATES.has(state);
  const isDone      = state === 'done';
  const isError     = state === 'error';

  const glowOpacity = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.45] });
  const glowScale   = glowAnim.interpolate({ inputRange: [0, 1], outputRange: [1.1, 1.55] });

  return (
    <View style={styles.container}>
      {/* Wordmark */}
      <Text style={styles.wordmark}>walfly</Text>
      <Text style={styles.tagline}>{labelFor(state)}</Text>

      {/* Glow ring — only during recording */}
      <View style={styles.buttonArea}>
        {isRecording && (
          <Animated.View
            style={[
              styles.glowRing,
              { opacity: glowOpacity, transform: [{ scale: glowScale }] },
            ]}
          />
        )}

        <Pressable
          onPress={handlePress}
          disabled={isBusy}
          accessibilityRole="button"
          accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
        >
          <Animated.View
            style={[
              styles.button,
              isRecording && styles.buttonRecording,
              isDone       && styles.buttonDone,
              isError      && styles.buttonError,
              { opacity: pulseAnim },
            ]}
          >
            {/* Inner dot / stop square */}
            <View style={[
              styles.buttonInner,
              isRecording && styles.buttonInnerRecording,
            ]} />
          </Animated.View>
        </Pressable>
      </View>

      {/* Progress */}
      {(state === 'uploading' || state === 'processing') && (
        <View style={styles.progressContainer}>
          <Progress.Bar
            progress={progress}
            width={200}
            height={2}
            color={colors.amber}
            unfilledColor={colors.border}
            borderWidth={0}
            borderRadius={1}
          />
        </View>
      )}

      {state === 'requesting' && (
        <Progress.CircleSnail
          color={[colors.amber, colors.mist]}
          size={24}
          thickness={2}
        />
      )}

      {isError && error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>tap to try again</Text>
        </View>
      )}
    </View>
  );
}

function labelFor(state: RecordState): string {
  switch (state) {
    case 'idle':       return 'tap to begin';
    case 'requesting': return 'starting…';
    case 'recording':  return 'recording — tap to stop';
    case 'uploading':  return 'uploading…';
    case 'processing': return 'processing…';
    case 'done':       return 'saved';
    case 'error':      return 'something went wrong';
  }
}

const BUTTON_SIZE = 128;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.midnight,
    gap: spacing.lg,
  },
  wordmark: {
    fontFamily: fonts.display,
    fontSize: fontSizes.xxl,
    color: colors.cream,
    letterSpacing: 2,
    marginBottom: -spacing.sm,
  },
  tagline: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.mist,
    letterSpacing: 0.5,
  },
  buttonArea: {
    width: BUTTON_SIZE + 80,
    height: BUTTON_SIZE + 80,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.md,
  },
  glowRing: {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: colors.amber,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: colors.obsidian,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  buttonRecording: {
    borderColor: colors.amber,
    backgroundColor: colors.obsidian,
    ...shadow.glow,
  },
  buttonDone: {
    borderColor: colors.success,
  },
  buttonError: {
    borderColor: colors.error,
  },
  buttonInner: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.amber,
  },
  buttonInnerRecording: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,   // square when recording = "stop"
    backgroundColor: colors.amber,
  },
  progressContainer: {
    alignItems: 'center',
    marginTop: -spacing.xs,
  },
  errorBox: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  errorText: {
    fontFamily: fonts.body,
    color: colors.error,
    fontSize: fontSizes.sm,
    textAlign: 'center',
  },
  errorHint: {
    fontFamily: fonts.body,
    color: colors.mist,
    fontSize: fontSizes.xs,
    marginTop: spacing.xxs,
  },
});
