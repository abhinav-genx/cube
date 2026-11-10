import { Redirect, router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { PinDots } from '../components/PinDots';
import { PinPad } from '../components/PinPad';
import { Screen } from '../components/Screen';
import { disk, vaultExists } from '../lib/disk';
import { colors, space, type } from '../lib/theme';
import { PIN_MIN, usePin } from '../lib/usePin';
import { setup } from '../lib/vault';

const STEPS: { title: string; hint?: string }[] = [
  { title: 'Choose the PIN that opens your files.', hint: 'At least 4 digits. Longer is safer.' },
  { title: 'Enter it once more.' },
  {
    title: 'Choose a second PIN.',
    hint: 'It opens a separate set of files, the one you can show if someone insists. Keep a few ordinary files there.',
  },
  { title: 'Enter the second PIN once more.' },
  {
    title: 'Choose a third PIN.',
    hint: 'Entering it permanently destroys the first set of files and opens the second, exactly as the second PIN would. No warning, no undo.',
  },
  { title: 'Enter the third PIN once more.' },
];

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function SetupScreen() {
  const pin = usePin();
  const pins = useRef<(Uint8Array | null)[]>([null, null, null]);
  const pending = useRef<Uint8Array | null>(null);
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // Reachable by deep link (cube://setup); setting up again would destroy the existing vaults.
  const [alreadySetUp] = useState(() => vaultExists());

  const which = Math.floor(step / 2);   // 0, 1, 2
  const confirming = step % 2 === 1;

  const reject = (text: string) => {
    setMessage(text);
    setShake((s) => s + 1);
  };

  const wipeDrafts = () => {
    pins.current.forEach((p) => p?.fill(0));
    pins.current = [null, null, null];
    pending.current?.fill(0);
    pending.current = null;
  };

  const startOver = () => {
    wipeDrafts();
    pin.clear();
    setMessage(null);
    setStep(0);
  };

  const create = async () => {
    const [a, b, c] = pins.current;
    if (!a || !b || !c) return;
    setBusy(true);
    try {
      await setup(a, b, c, disk);   // zeros the PIN buffers itself
      pins.current = [null, null, null];
      setDone(true);
    } catch (e) {
      const text = e instanceof Error ? e.message : '';
      setMessage(
        /secure hardware|keystore|keychain/i.test(text)
          ? 'This device cannot keep keys in secure hardware, so Cube cannot run here.'
          : 'Could not create the vault. Check that a device lock screen is set, then try again.',
      );
      wipeDrafts();
      setStep(0);
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (busy || pin.count < PIN_MIN) return;
    const bytes = pin.take();
    setMessage(null);

    if (!confirming) {
      const clash = pins.current.some((p) => p && same(p, bytes));
      if (clash) {
        bytes.fill(0);
        reject('Use a different PIN for each.');
        return;
      }
      pending.current = bytes;
      setStep(step + 1);
      return;
    }

    const first = pending.current;
    pending.current = null;
    if (!first || !same(first, bytes)) {
      first?.fill(0);
      bytes.fill(0);
      setStep(step - 1);
      reject('The two entries differ. Enter this PIN again.');
      return;
    }
    bytes.fill(0);
    pins.current[which] = first;
    if (which < 2) setStep(step + 1);
    else void create();
  };

  if (alreadySetUp) return <Redirect href="/" />;

  if (done) {
    return (
      <Screen>
        <View style={styles.doneHero}>
          <Logo size={112} />
        </View>
        <View style={styles.doneText}>
          <Text style={styles.title}>Your vault is ready.</Text>
          <Text style={styles.hint}>
            Open it with the first PIN. Soon, put a few ordinary files behind the second PIN so it
            looks lived-in. A forgotten PIN cannot be recovered.
          </Text>
        </View>
        <Button title="Go to the lock screen" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  const current = STEPS[step];

  return (
    <Screen>
      <View style={styles.header}>
        <Logo size={40} />
        <View style={styles.progress}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.bar, i < which && styles.barDone, i === which && styles.barNow]} />
          ))}
        </View>
      </View>

      <View style={styles.copy}>
        <Text style={styles.title}>{current.title}</Text>
        {current.hint ? <Text style={styles.hint}>{current.hint}</Text> : null}
      </View>

      <View style={styles.entry}>
        <PinDots count={pin.count} shakeKey={shake} />
        <Text style={styles.message}>{busy ? 'Creating your vault…' : (message ?? ' ')}</Text>
        <PinPad
          onDigit={(d) => {
            setMessage(null);
            pin.push(d);
          }}
          onBackspace={pin.pop}
          onConfirm={confirm}
          confirmEnabled={pin.count >= PIN_MIN}
          disabled={busy}
        />
        <Button
          title="Start over"
          variant="quiet"
          onPress={startOver}
          disabled={busy || (step === 0 && pin.count === 0)}
          style={styles.startOver}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { flexDirection: 'row', gap: 6 },
  bar: { width: 28, height: 4, borderRadius: 2, backgroundColor: colors.mist },
  barDone: { backgroundColor: colors.leaf },
  barNow: { backgroundColor: colors.sage },
  copy: { flex: 1, justifyContent: 'center', gap: space.s, maxWidth: 420 },
  title: { ...type.title, color: colors.leaf },
  hint: { ...type.body, color: colors.sage },
  entry: { alignItems: 'center', gap: space.m },
  message: { ...type.small, color: colors.resin, textAlign: 'center', height: 20 },
  startOver: { minHeight: 44 },
  doneHero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  doneText: { gap: space.s, paddingBottom: space.xl, maxWidth: 420 },
});
