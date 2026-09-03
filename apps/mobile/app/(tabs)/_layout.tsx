import { DynamicColorIOS } from 'react-native';
import { ThemeProvider, DarkTheme } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { colors } from '../../lib/theme';

const tintColor = DynamicColorIOS({ dark: colors.amber, light: colors.amberDim });
const labelColor = DynamicColorIOS({ dark: colors.cream, light: '#1A1A1C' });

export default function TabLayout() {
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
