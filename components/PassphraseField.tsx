import { useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { colors, radius, space, type } from '../lib/theme';
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
 * the field is cleared the moment the passphrase is handed over. React Native only gives text
 * fields to JavaScript as strings, which cannot be zeroed, so unlike the keypad a passphrase may
 * linger in memory until garbage collection (README, Vulnerabilities).
 */
export function PassphraseField({ onSubmit, minLength, submitTitle, disabled, autoFocus = true }: Props) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const text = useRef('');
  const [length, setLength] = useState(0);

  const submit = () => {
    if (disabled || length < minLength) return;
    // NFC so the same words typed on different keyboards give the same bytes.
    const bytes = new TextEncoder().encode(text.current.normalize('NFC'));
    text.current = '';
    input.current?.clear();
    setLength(0);
    onSubmit(bytes);
  };

  return (
    <View style={styles.wrap}>
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
        onSubmitEditing={submit}
        accessibilityLabel="Passphrase"
      />
      <Button title={submitTitle} onPress={submit} disabled={disabled || length < minLength} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: space.m },
  field: {
    ...type.body,
    color: colors.leaf,
    backgroundColor: colors.mist,
    borderRadius: radius.row,
    paddingHorizontal: space.m,
    paddingVertical: space.m,
  },
});
