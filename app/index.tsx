import * as Haptics from 'expo-haptics';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Logo } from '../components/Logo';
import { PinDots } from '../components/PinDots';
import { PinPad } from '../components/PinPad';
import { Screen } from '../components/Screen';
import { disk, vaultExists } from '../lib/disk';
import { startSession } from '../lib/session';
import { colors, space, type } from '../lib/theme';
import { PIN_MIN, usePin } from '../lib/usePin';
import { SOFTWARE_KEYS, unlock } from '../lib/vault';

export default function LockScreen() {
  const [exists, setExists] = useState(() => vaultExists());
  const pin = usePin();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  useFocusEffect(
    useCallback(() => {
      setExists(vaultExists());
      setMessage(null);
    }, []),
  );

  if (!exists) return <Redirect href="/setup" />;

  const submit = async () => {
    if (busy || pin.count < PIN_MIN) return;
    setBusy(true);
    setMessage(null);
    const bytes = pin.take();
    try {
      const opened = await unlock(bytes, disk);
      startSession(opened);
      router.replace('/vault');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code ?? '';
      if (code.startsWith('E_AUTH') || code.startsWith('E_BIOMETRIC')) {
        setMessage('Unlock cancelled.');
      } else {
        // Wrong PIN, missing header, tampered slot: one message for all of them.
        setMessage('Wrong PIN');
        setShake((s) => s + 1);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
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
        <PinDots count={pin.count} shakeKey={shake} />
        <View style={styles.status}>
          {busy ? (
            <ActivityIndicator color={colors.leaf} />
          ) : (
            <Text style={styles.message}>{message ?? ' '}</Text>
          )}
        </View>
        <PinPad
          onDigit={(d) => {
            setMessage(null);
            pin.push(d);
          }}
          onBackspace={pin.pop}
          onConfirm={submit}
          confirmEnabled={pin.count >= PIN_MIN}
          disabled={busy}
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
});
