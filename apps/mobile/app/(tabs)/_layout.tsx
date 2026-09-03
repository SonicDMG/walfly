import { Platform } from 'react-native';
import { ThemeProvider, DarkTheme } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { colors } from '../../lib/theme';

// DynamicColorIOS is iOS-only — calling it at module level crashes the web
// static renderer. We lazily resolve it inside the component so it only runs
// on a live iOS runtime, never during SSR/static export.
function iosColor(dark: string, light: string): string {
  if (Platform.OS !== 'ios') return dark;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DynamicColorIOS } = require('react-native') as typeof import('react-native');
  return DynamicColorIOS({ dark, light }) as unknown as string;
}

export default function TabLayout() {
  const tintColor  = iosColor(colors.amber,  colors.amberDim);
  const labelColor = iosColor(colors.cream,  '#1A1A1C');

  return (
    <ThemeProvider value={DarkTheme}>
      <NativeTabs
        tintColor={tintColor}
        labelStyle={{ color: labelColor }}
        iconColor={{ default: colors.mist, selected: colors.amber }}
      >
        <NativeTabs.Trigger name="index" disableTransparentOnScrollEdge>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'mic', selected: 'mic.fill' }}
            md={{ default: 'mic', selected: 'mic' }}
          />
          <NativeTabs.Trigger.Label>record</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="recordings" disableTransparentOnScrollEdge>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'square.stack', selected: 'square.stack.fill' }}
            md={{ default: 'layers', selected: 'layers' }}
          />
          <NativeTabs.Trigger.Label>moments</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="chat" disableTransparentOnScrollEdge>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'bubble.left', selected: 'bubble.left.fill' }}
            md={{ default: 'chat_bubble_outline', selected: 'chat_bubble' }}
          />
          <NativeTabs.Trigger.Label>chat</NativeTabs.Trigger.Label>
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
