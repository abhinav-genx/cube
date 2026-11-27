import type { ReactNode } from 'react';
import { KeyboardAvoidingView, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { touch } from '../lib/session';
import { type Palette, space, useStyles } from '../lib/theme';

type Props = { children: ReactNode; style?: ViewStyle; padded?: boolean; wide?: boolean };

/** On a tablet, content stays this wide (centred) so lines and the keypad keep a phone's proportions. */
const CONTENT_MAX = 600;

/**
 * Every screen sits in this. The responder-capture hook sees every touch without stealing
 * it, which is how the idle timer in lib/session.ts learns the person is still here.
 */
export function Screen({ children, style, padded = true, wide = false }: Props) {
  const styles = useStyles(makeStyles);
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
        {wide ? children : <View style={styles.content}>{children}</View>}
      </View>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.frost },
  root: { flex: 1, backgroundColor: colors.frost },
  content: { flex: 1, width: '100%', maxWidth: CONTENT_MAX, alignSelf: 'center' },
});
