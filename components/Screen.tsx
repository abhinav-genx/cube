import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { touch } from '../lib/session';
import { colors, space } from '../lib/theme';

type Props = { children: ReactNode; style?: ViewStyle; padded?: boolean };

/**
 * Every screen sits in this. The responder-capture hook sees every touch without stealing
 * it, which is how the idle timer in lib/session.ts learns the person is still here.
 */
export function Screen({ children, style, padded = true }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View
      onStartShouldSetResponderCapture={() => {
        touch();
        return false;
      }}
      style={[
        styles.root,
        {
          paddingTop: insets.top + (padded ? space.m : 0),
          paddingBottom: insets.bottom + (padded ? space.m : 0),
          paddingLeft: insets.left + (padded ? space.l : 0),
          paddingRight: insets.right + (padded ? space.l : 0),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.frost },
});
