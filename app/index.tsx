import * as Haptics from 'expo-haptics';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { PassphraseField } from '../components/PassphraseField';
import { PinDots } from '../components/PinDots';
import { PinPad } from '../components/PinPad';
import { Screen } from '../components/Screen';
import { disk, readEntryMode, vaultExists, type EntryMode } from '../lib/disk';
import { startSession } from '../lib/session';
import { colors, space, type } from '../lib/theme';
import { PIN_MIN, usePin } from '../lib/usePin';
import { SOFTWARE_KEYS, TooSoon, unlock, unlockWaitMs } from '../lib/vault';

function formatWait(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function LockScreen() {
  const [exists, setExists] = useState(() => vaultExists());
  const pin = usePin();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  // After several wrong PINs the next attempt has to wait (lib/vault.ts, attempt delay).
  const [wait, setWait] = useState(0);
  // Keypad or passphrase field; setup picks the default, and you can always switch.
  const [mode, setMode] = useState<EntryMode>(() => readEntryMode());

  const refreshWait = useCallback(() => {
    unlockWaitMs(disk).then(setWait, () => setWait(0));
  }, []);

  useFocusEffect(
    useCallback(() => {
      setExists(vaultExists());
      setMessage(null);
      refreshWait();
    }, [refreshWait]),
  );

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(refreshWait, Math.min(wait, 1000));
    return () => clearTimeout(t);
  }, [wait, refreshWait]);

  if (!exists) return <Redirect href="/setup" />;

  const submitPin = () => {
    if (busy || wait > 0 || pin.size() < PIN_MIN) return;   // size(), not count: see usePin
    void submit(pin.take());
  };

  const submit = async (bytes: Uint8Array) => {
    if (busy || wait > 0) {
      bytes.fill(0);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const opened = await unlock(bytes, disk);
      startSession(opened);
      router.replace('/vault');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      if (e instanceof TooSoon) {
        setWait(e.waitMs);
      } else if (code.startsWith('E_AUTH') || code.startsWith('E_BIOMETRIC')) {
        setMessage('Unlock cancelled.');
      } else {
        // Wrong PIN, missing header, tampered slot: one message for all of them.
        setMessage(mode === 'pin' ? 'Wrong PIN' : 'Wrong passphrase');
        setShake((s) => s + 1);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        refreshWait();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <Logo size={136} />
        {SOFTWARE_KEYS ? <Text style={styles.testing}>Testing build: software keys, no hardware protection</Text> : null}
      </View>

      <View style={styles.entry}>
        {mode === 'pin' ? <PinDots count={pin.count} shakeKey={shake} /> : null}
        <View style={styles.status}>
          {busy ? (
            <ActivityIndicator color={colors.leaf} />
          ) : (
            <Text style={styles.message}>
              {wait > 0 ? `Too many tries. Try again in ${formatWait(wait)}` : (message ?? ' ')}
            </Text>
          )}
        </View>
        {mode === 'pin' ? (
          <PinPad
            onDigit={(d) => {
              setMessage(null);
              pin.push(d);
            }}
            onBackspace={pin.pop}
            onConfirm={submitPin}
            confirmEnabled={pin.count >= PIN_MIN && wait === 0}
            disabled={busy || wait > 0}
          />
        ) : (
          <PassphraseField onSubmit={(b) => void submit(b)} minLength={1} submitTitle="Unlock" disabled={busy || wait > 0} />
        )}
        <Button
          title={mode === 'pin' ? 'Use passphrase' : 'Use PIN'}
          variant="quiet"
          onPress={() => {
            pin.clear();
            setMessage(null);
            setMode(mode === 'pin' ? 'phrase' : 'pin');
          }}
          disabled={busy}
          style={styles.switch}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.m },
  testing: { ...type.small, color: colors.resin, textAlign: 'center' },
  entry: { alignItems: 'center', gap: space.l, paddingBottom: space.m },
  status: { height: 24, alignItems: 'center', justifyContent: 'center' },
  message: { ...type.small, color: colors.resin },
  switch: { minHeight: 44 },
});
