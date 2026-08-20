/**
 * Tab 1 — Record Screen
 *
 * Large record button. Tap to start, tap again to stop.
 * Location permission is requested at tap-start — gracefully degrades if denied.
 * Progress and wait states use react-native-progress for animated feedback.
 */

import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
} from 'react-native';
import * as Progress from 'react-native-progress';
import { useRecordingUpload, RecordState } from '../../hooks/useRecordingUpload';

const RED = '#E53935';
const DARK = '#1a1a1a';
const MUTED = '#888';

export default function RecordScreen() {
  const { state, error, progress, startRecording, stopAndUpload, reset } =
    useRecordingUpload();

  // Pulse animation for recording state
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state === 'recording') {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.55, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [state]);

  function handlePress() {
    if (state === 'idle' || state === 'error' || state === 'done') {
      if (state === 'error') reset();
      startRecording();
    } else if (state === 'recording') {
      stopAndUpload();
    }
    // 'uploading' / 'processing' / 'requesting' — ignore taps
  }

  const isActive = state === 'recording';
  const isBusy = state === 'uploading' || state === 'processing' || state === 'requesting';
  const isDone = state === 'done';

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Walfly</Text>
      <Text style={styles.subheading}>
        {labelFor(state)}
      </Text>

      {/* Record button */}
      <Pressable
        onPress={handlePress}
        disabled={isBusy}
        style={styles.buttonWrapper}
        accessibilityRole="button"
        accessibilityLabel={isActive ? 'Stop recording' : 'Start recording'}
      >
        <Animated.View
          style={[
            styles.button,
            isActive && styles.buttonActive,
            isDone && styles.buttonDone,
            isBusy && styles.buttonBusy,
            { opacity: isActive ? pulseAnim : 1 },
          ]}
        >
        </Animated.View>
      </Pressable>

      {/* Progress bar — shown while uploading or processing */}
      {isBusy && (
        <View style={styles.progressContainer}>
          <Progress.Bar
            progress={progress}
            width={220}
            height={6}
            color={RED}
            unfilledColor="#eee"
            borderWidth={0}
            borderRadius={3}
          />
          <Text style={styles.progressLabel}>
            {state === 'uploading' ? 'Uploading…' : 'Processing…'}
          </Text>
        </View>
      )}

      {/* Spinner for requesting state */}
      {state === 'requesting' && (
        <View style={styles.progressContainer}>
          <Progress.CircleSnail
            color={[RED, '#888']}
            size={32}
            thickness={3}
          />
          <Text style={styles.progressLabel}>Getting location…</Text>
        </View>
      )}

      {/* Error state */}
      {state === 'error' && error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>Tap to try again</Text>
        </View>
      )}
    </View>
  );
}

function labelFor(state: RecordState): string {
  switch (state) {
    case 'idle': return 'Tap to record';
    case 'requesting': return 'Getting location…';
    case 'recording': return 'Recording — tap to stop';
    case 'uploading': return 'Uploading…';
    case 'processing': return 'Processing…';
    case 'done': return 'Done!';
    case 'error': return 'Something went wrong';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    gap: 24,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    color: DARK,
    letterSpacing: 1,
  },
  subheading: {
    fontSize: 15,
    color: MUTED,
    marginTop: -16,
  },
  buttonWrapper: {
    marginVertical: 8,
  },
  button: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: RED,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonActive: {
    // color stays red — shape change handled inline
  },
  buttonDone: {
    backgroundColor: '#43A047',
  },
  buttonBusy: {
    opacity: 0.5,
  },
  progressContainer: {
    alignItems: 'center',
    gap: 8,
  },
  progressLabel: {
    fontSize: 13,
    color: MUTED,
  },
  errorBox: {
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  errorText: {
    color: RED,
    fontSize: 14,
    textAlign: 'center',
  },
  errorHint: {
    color: MUTED,
    fontSize: 12,
    marginTop: 4,
  },
});
