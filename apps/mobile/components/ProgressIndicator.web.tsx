/**
 * ProgressIndicator — web
 *
 * react-native-progress uses react-native-svg, whose web shim passes all props
 * (including the RN-only `collapsable: false` injected by react-native-web's
 * Animated wrapper) straight through to react-dom as raw DOM attributes.
 * That causes a console error on every render.
 *
 * On web we have no native modules, so we use plain RN primitives instead:
 *  - spinner  → ActivityIndicator (renders a CSS-animated <div>, no SVG)
 *  - bar      → a simple View with an inner View sized by `progress`
 *
 * Expo's resolver picks *.web.tsx over *.tsx automatically, so native builds
 * never see this file.
 */

import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, spacing } from '../lib/theme';

interface Props {
  variant: 'bar' | 'spinner';
  progress?: number;
}

export default function ProgressIndicator({ variant, progress = 0 }: Props) {
  if (variant === 'spinner') {
    return <ActivityIndicator size="small" color={colors.amber} />;
  }

  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 200,
    height: 2,
    marginTop: -spacing.xs,
    backgroundColor: colors.border,
    borderRadius: 1,
    overflow: 'hidden',
  },
  fill: {
    height: 2,
    backgroundColor: colors.amber,
    borderRadius: 1,
  },
});
