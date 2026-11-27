import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import CubeNative, { CubeSecureField, type SecureFieldRef } from '../modules/cube-native';
import { type Palette, radius, space, type, useColors, useStyles } from '../lib/theme';
import { Button } from './Button';

type Props = {
  onSubmit: (bytes: Uint8Array) => void;
  minLength: number;
  submitTitle: string;
  disabled?: boolean;
  /** Focus (and open the keyboard) on mount, so each setup step continues where the last left off. */
  autoFocus?: boolean;
};

/**
 * Passphrase entry, the alternative to the keypad: letters, digits, spaces, anything.
 *
 * The keyboard is told not to learn or suggest (secure entry, no autocorrect, no autofill), and
 * the field is cleared the moment the passphrase is handed over. Where the native field
 * (modules/cube-native CubeSecureField) is linked, the passphrase never becomes a JavaScript string:
 * JavaScript sees only its length, then takes it as bytes. Elsewhere (tests, web) a TextInput is
 * used, whose text is a string that cannot be zeroed (README, Vulnerabilities).
 *
 * On Android any installed keyboard app can be the one receiving the keystrokes, and it sees every
 * key. When the active keyboard is not part of the phone's system, a warning says so. (iOS always
 * uses its own keyboard for password fields.)
 */
export function PassphraseField({ onSubmit, minLength, submitTitle, disabled, autoFocus = true }: Props) {
  const colors = useColors();
  const styles = useStyles(makeStyles);
  const Secure = CubeSecureField();
  const secure = useRef<SecureFieldRef>(null);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const text = useRef('');
  const [length, setLength] = useState(0);
  const [keyboard, setKeyboard] = useState<string | null>(null);   // third-party keyboard's name

  const checkKeyboard = useCallback(() => {
    if (Platform.OS !== 'android') return;
    try {
      const info = CubeNative?.keyboardInfo();
      setKeyboard(info?.thirdParty ? info.name || 'This keyboard' : null);
    } catch {
      setKeyboard(null);
    }
  }, []);
  useEffect(checkKeyboard, [checkKeyboard]);

  const submit = async () => {
    if (disabled || length < minLength) return;
    if (Secure && secure.current) {
      // Byte values straight from the native field (already NFC); the plain array is wiped after.
      const values = await secure.current.take();
      const bytes = Uint8Array.from(values);
      values.fill(0);
      setLength(0);
      onSubmit(bytes);
      return;
    }
    // NFC so the same words typed on different keyboards give the same bytes.
    const bytes = new TextEncoder().encode(text.current.normalize('NFC'));
    text.current = '';
    input.current?.clear();
    setLength(0);
    onSubmit(bytes);
  };

  return (
    <View style={styles.wrap}>
      {Secure ? (
        <Secure
          ref={secure}
          style={[styles.field, styles.native]}
          placeholder="Passphrase"
          placeholderColor={colors.sage}
          textColor={colors.leaf}
          fontSize={type.body.fontSize}
          editable={!disabled}
          autoFocus={autoFocus}
          onLengthChange={(e) => setLength(e.nativeEvent.length)}
          onSubmit={() => void submit()}
          onFocusChange={(e) => e.nativeEvent.focused && checkKeyboard()}
          accessibilityLabel="Passphrase"
        />
      ) : (
      <TextInput
        ref={input}
        style={styles.field}
        placeholder="Passphrase"
        placeholderTextColor={colors.sage}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        textContentType="none"
        contextMenuHidden
        editable={!disabled}
        autoFocus={autoFocus}
        returnKeyType="done"
        onChangeText={(t) => {
          text.current = t;
          setLength(t.length);
        }}
        onSubmitEditing={() => void submit()}
        onFocus={checkKeyboard}
        accessibilityLabel="Passphrase"
      />
      )}
      {keyboard ? (
        <Text style={styles.warning}>
          {keyboard} is a third-party keyboard and can see everything typed here. Switch to your phone’s built-in
          keyboard, or use the PIN pad.
        </Text>
      ) : null}
      <Button title={submitTitle} onPress={() => void submit()} disabled={disabled || length < minLength} />
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: space.m },
  warning: { ...type.small, color: colors.resin },
  field: {
    ...type.body,
    color: colors.leaf,
    backgroundColor: colors.mist,
    borderRadius: radius.row,
    paddingHorizontal: space.m,
    paddingVertical: space.m,
  },
  // The native field draws its own insets and has no intrinsic size.
  native: { height: 56, paddingHorizontal: 0, paddingVertical: 0 },
});
