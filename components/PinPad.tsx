import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { randombytes_uniform } from 'react-native-libsodium';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { colors, radius, type } from '../lib/theme';

type Props = {
  onDigit: (digit: number) => void;
  onBackspace: () => void;
  onConfirm: () => void;
  confirmEnabled: boolean;
  disabled?: boolean;
};

type Key = number | 'back' | 'ok';

/** Digits 0–9 in a fresh random order (Fisher–Yates, libsodium randomness), back and OK fixed. */
function shuffledKeys(): Key[] {
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = d.length - 1; i > 0; i--) {
    const j = randombytes_uniform(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return [d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], 'back', d[9], 'ok'];
}

/**
 * Release builds keep the digits out of reach of accessibility services, which could otherwise
 * read every key (malware with accessibility access is a known keylogger). Marking views
 * "unimportant" is not enough: a service can ask for those too. So in release builds the digits
 * are drawn as vector graphics, not text, and the keys carry no label or description; with the
 * shuffled layout, a service sees only unnamed boxes. This makes the keypad unusable with a
 * screen reader — a deliberate trade-off. Debug builds keep text and labels for UI automation.
 */
const HIDE_FROM_ACCESSIBILITY = !__DEV__;

/** A digit drawn by react-native-svg: pixels on screen, no text in the accessibility tree. */
function DigitGlyph({ digit, color }: { digit: number; color: string }) {
  return (
    <Svg width={40} height={44} viewBox="0 0 40 44" accessible={false}>
      <SvgText x={20} y={34} fontSize={32} fontFamily="InstrumentSans_400Regular" fill={color} textAnchor="middle">
        {String(digit)}
      </SvgText>
    </Svg>
  );
}

/**
 * The PIN never touches the system keyboard (no autocorrect learning, no keyboard cache)
 * and never becomes a string in React state: the screen appends each digit to a Uint8Array.
 * The digits are shuffled each time the keypad appears, so where a finger lands (a camera,
 * a shoulder-surfer, smudges on the glass) says nothing about the PIN.
 */
export function PinPad({ onDigit, onBackspace, onConfirm, confirmEnabled, disabled }: Props) {
  const [keys] = useState(shuffledKeys);
  const press = (k: Key) => {
    if (disabled) return;
    void Haptics.selectionAsync();
    if (k === 'back') onBackspace();
    else if (k === 'ok') onConfirm();
    else onDigit(k);
  };

  return (
    <View
      style={styles.grid}
      importantForAccessibility={HIDE_FROM_ACCESSIBILITY ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={HIDE_FROM_ACCESSIBILITY}
    >
      {keys.map((k) => {
        const isOk = k === 'ok';
        const off = disabled || (isOk && !confirmEnabled);
        return (
          <Pressable
            key={String(k)}
            onPress={() => press(k)}
            // Confirm only looks disabled while the PIN is short: natively disabling it dropped a
            // Confirm tapped right after the last digit, before React re-rendered. onConfirm
            // checks the length itself.
            disabled={disabled}
            accessibilityState={{ disabled: off }}
            accessible={!HIDE_FROM_ACCESSIBILITY}
            importantForAccessibility={HIDE_FROM_ACCESSIBILITY ? 'no' : 'auto'}
            accessibilityRole={HIDE_FROM_ACCESSIBILITY ? undefined : 'button'}
            accessibilityLabel={
              HIDE_FROM_ACCESSIBILITY ? undefined : k === 'back' ? 'Delete digit' : isOk ? 'Confirm' : String(k)
            }
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
              HIDE_FROM_ACCESSIBILITY ? (
                <DigitGlyph digit={k} color={disabled ? colors.sage : colors.leaf} />
              ) : (
                <Text style={[styles.digit, disabled && styles.digitOff]}>{k}</Text>
              )
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
