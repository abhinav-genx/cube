import type { ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View, type ViewStyle } from 'react-native';
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
  // Android 15+ draws apps edge to edge, so the window no longer shrinks for the keyboard;
  // without this the passphrase field and its button sit under the keyboard.
  return (
    <KeyboardAvoidingView style={styles.fill} behavior="padding">
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
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.frost },
  root: { flex: 1, backgroundColor: colors.frost },
});
