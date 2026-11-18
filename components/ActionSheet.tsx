import { ActionSheetIOS, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, space, type } from '../lib/theme';

export type SheetAction = { label: string; onPress: () => void };

type Props = {
  visible: boolean;
  title: string;
  actions: SheetAction[];
  onClose: () => void;
};

/**
 * Android's bottom sheet: a list of choices that slides up from the bottom, closed by Cancel, a
 * tap outside or the back button. iOS uses the system action sheet instead (showActionSheet).
 */
export function ActionSheet({ visible, title, actions, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const choose = (fn: () => void) => {
    onClose();
    fn();
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.m) }]}>
        <Text style={styles.title}>{title}</Text>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={() => choose(a.onPress)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <Text style={styles.label}>{a.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={onClose} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
          <Text style={[styles.label, styles.cancel]}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** iOS: the system action sheet. Returns false where it does not exist (Android: use ActionSheet). */
export function showActionSheet(title: string, actions: SheetAction[]): boolean {
  if (Platform.OS !== 'ios') return false;
  ActionSheetIOS.showActionSheetWithOptions(
    { title, options: [...actions.map((a) => a.label), 'Cancel'], cancelButtonIndex: actions.length },
    (i) => {
      if (i < actions.length) actions[i].onPress();
    },
  );
  return true;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(21, 48, 29, 0.35)' },
  sheet: {
    backgroundColor: colors.frost,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.m,
    paddingHorizontal: space.s,
  },
  title: { ...type.small, color: colors.sage, textAlign: 'center', paddingBottom: space.s },
  row: { minHeight: 52, justifyContent: 'center', paddingHorizontal: space.m, borderRadius: radius.row },
  rowPressed: { backgroundColor: colors.mist },
  label: { ...type.bodyMedium, color: colors.leaf },
  cancel: { color: colors.sage },
});
