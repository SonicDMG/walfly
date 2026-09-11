/**
 * ProgressIndicator — native
 *
 * Uses react-native-progress (SVG-backed). Safe on iOS/Android where
 * react-native-svg renders via native modules, not react-dom.
 */

import { View, StyleSheet } from 'react-native';
import * as Progress from 'react-native-progress';
import { colors, spacing } from '../lib/theme';

interface Props {
  /** 'bar' shows a determinate progress bar; 'spinner' shows a CircleSnail. */
  variant: 'bar' | 'spinner';
  /** 0–1, only used when variant='bar' */
  progress?: number;
}

export default function ProgressIndicator({ variant, progress = 0 }: Props) {
  if (variant === 'spinner') {
    return (
      <Progress.CircleSnail
        color={[colors.amber, colors.mist]}
        size={24}
        thickness={2}
      />
    );
  }

  return (
    <View style={styles.barContainer}>
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
  );
}

const styles = StyleSheet.create({
  barContainer: {
    alignItems: 'center',
    marginTop: -spacing.xs,
  },
});
