import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, radius, type } from '../lib/theme';

type Props = {
  onDigit: (digit: number) => void;
  onBackspace: () => void;
  onConfirm: () => void;
  confirmEnabled: boolean;
  disabled?: boolean;
};

const KEYS: (number | 'back' | 'ok')[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 'back', 0, 'ok'];

/**
 * The PIN never touches the system keyboard (no autocorrect learning, no keyboard cache)
 * and never becomes a string in React state: the screen appends each digit to a Uint8Array.
 */
export function PinPad({ onDigit, onBackspace, onConfirm, confirmEnabled, disabled }: Props) {
  const press = (k: (typeof KEYS)[number]) => {
    if (disabled) return;
    void Haptics.selectionAsync();
    if (k === 'back') onBackspace();
    else if (k === 'ok') onConfirm();
    else onDigit(k);
  };

  return (
    <View style={styles.grid}>
      {KEYS.map((k) => {
        const isOk = k === 'ok';
        const off = disabled || (isOk && !confirmEnabled);
        return (
          <Pressable
            key={String(k)}
            onPress={() => press(k)}
            disabled={off}
            accessibilityRole="button"
            accessibilityLabel={k === 'back' ? 'Delete digit' : isOk ? 'Confirm' : String(k)}
            style={({ pressed }) => [
              styles.key,
              isOk && styles.okKey,
              isOk && !confirmEnabled && styles.okKeyOff,
              pressed && !isOk && styles.keyPressed,
              pressed && isOk && confirmEnabled && styles.okKeyPressed,
            ]}
          >
            {k === 'back' ? (
              <BackspaceGlyph />
            ) : isOk ? (
              <CheckGlyph color={confirmEnabled ? colors.frost : colors.sage} />
            ) : (
              <Text style={[styles.digit, disabled && styles.digitOff]}>{k}</Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

function BackspaceGlyph() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7 6-7Zm3.5 4.5 5 5m0-5-5 5"
        stroke={colors.leaf}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CheckGlyph({ color }: { color: string }) {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path d="M5 12.5l4.5 4.5L19 7.5" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const KEY = 76;

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: KEY * 3 + 24 * 2,
    columnGap: 24,
    rowGap: 14,
    alignSelf: 'center',
  },
  key: {
    width: KEY,
    height: KEY,
    borderRadius: radius.key,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: colors.mist },
  okKey: { backgroundColor: colors.leaf },
  okKeyOff: { backgroundColor: colors.mist },
  okKeyPressed: { backgroundColor: colors.pine },
  digit: { ...type.key, color: colors.leaf },
  digitOff: { color: colors.sage },
});
