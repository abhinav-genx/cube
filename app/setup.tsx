import { Redirect, router } from 'expo-router';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { PassphraseField } from '../components/PassphraseField';
import { PinDots } from '../components/PinDots';
import { PinPad } from '../components/PinPad';
import { Screen } from '../components/Screen';
import { disk, vaultExists, writeEntryMode, type EntryMode } from '../lib/disk';
import { type Palette, space, type, useStyles } from '../lib/theme';
import { SETUP_PIN_MIN, usePin } from '../lib/usePin';
import { forgetStaleKeys, setup } from '../lib/vault';

/** Shortest passphrase setup accepts. A few unrelated words beat any PIN. */
const PHRASE_MIN = 8;

function steps(noun: string, mode: EntryMode): { title: string; hint?: string }[] {
  return [
    {
      title: `Choose the ${noun} that opens your files.`,
      hint: mode === 'pin' ? 'At least 8 digits. Longer is safer; a passphrase is safer still.' : 'At least 8 characters. A few unrelated words work best.',
    },
    { title: 'Enter it once more.' },
    {
      title: `Choose a second ${noun}.`,
      hint: 'It opens a separate set of files, the one you can show if someone insists. Keep a few ordinary files there.',
    },
    { title: `Enter the second ${noun} once more.` },
    {
      title: `Choose a third ${noun}.`,
      hint: `Entering it permanently destroys the first set of files and opens the second, exactly as the second ${noun} would. No warning, no undo.`,
    },
    { title: `Enter the third ${noun} once more.` },
  ];
}

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function SetupScreen() {
  const styles = useStyles(makeStyles);
  const pin = usePin();
  const pins = useRef<(Uint8Array | null)[]>([null, null, null]);
  const pending = useRef<Uint8Array | null>(null);
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // All three secrets use the same kind of entry, chosen before the first one is entered.
  const [mode, setMode] = useState<EntryMode>('pin');
  const [fieldKey, setFieldKey] = useState(0);   // bumping it clears the passphrase field
  const noun = mode === 'pin' ? 'PIN' : 'passphrase';
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
    setFieldKey((k) => k + 1);
    setMessage(null);
    setStep(0);
  };

  const create = async () => {
    const [a, b, c] = pins.current;
    if (!a || !b || !c) return;
    setBusy(true);
    try {
      await forgetStaleKeys(disk);   // keys an uninstalled copy or an unfinished setup left behind
      await setup(a, b, c, disk);   // zeros the PIN buffers itself
      pins.current = [null, null, null];
      await writeEntryMode(mode).catch(() => undefined);   // only the lock screen's default
      setDone(true);
    } catch (e) {
      if (__DEV__) console.warn('setup failed', e);
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
    if (busy || pin.size() < SETUP_PIN_MIN) return;   // size(), not count: see usePin
    accept(pin.take());
  };

  const accept = (bytes: Uint8Array) => {
    if (busy) {
      bytes.fill(0);
      return;
    }
    setMessage(null);

    if (!confirming) {
      const clash = pins.current.some((p) => p && same(p, bytes));
      if (clash) {
        bytes.fill(0);
        reject(`Use a different ${noun} for each.`);
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
      reject(`The two entries differ. Enter this ${noun} again.`);
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
            Open it with the first {noun}. Soon, put a few ordinary files behind the second {noun} so
            it looks lived-in. A forgotten {noun} cannot be recovered.
          </Text>
        </View>
        <Button title="Go to the lock screen" onPress={() => router.replace('/')} />
      </Screen>
    );
  }

  const current = steps(noun, mode)[step];

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

      {/* Scrolls when the keyboard leaves too little room, so the hint (on the last step, the
          warning about the third secret) never ends up drawn underneath the message or field. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      <View style={styles.copy}>
        <Text style={styles.title}>{current.title}</Text>
        {current.hint ? <Text style={styles.hint}>{current.hint}</Text> : null}
      </View>

      <View style={styles.entry}>
        {mode === 'pin' ? <PinDots count={pin.count} shakeKey={shake} min={SETUP_PIN_MIN} /> : null}
        <Text style={styles.message}>{busy ? 'Creating your vault…' : (message ?? ' ')}</Text>
        {mode === 'pin' ? (
          <PinPad
            onDigit={(d) => {
              setMessage(null);
              pin.push(d);
            }}
            onBackspace={pin.pop}
            onConfirm={confirm}
            confirmEnabled={pin.count >= SETUP_PIN_MIN}
            disabled={busy}
          />
        ) : (
          <PassphraseField key={`${step}-${fieldKey}`} onSubmit={accept} minLength={PHRASE_MIN} submitTitle="Continue" disabled={busy} />
        )}
        {step === 0 && !busy ? (
          <Button
            title={mode === 'pin' ? 'Use a passphrase instead' : 'Use a PIN instead'}
            variant="quiet"
            onPress={() => {
              pin.clear();
              setMessage(null);
              setMode(mode === 'pin' ? 'phrase' : 'pin');
            }}
            style={styles.startOver}
          />
        ) : null}
        <Button
          title="Start over"
          variant="quiet"
          onPress={startOver}
          disabled={busy || (step === 0 && pin.count === 0)}
          style={styles.startOver}
        />
      </View>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progress: { flexDirection: 'row', gap: 6 },
  bar: { width: 28, height: 4, borderRadius: 2, backgroundColor: colors.mist },
  barDone: { backgroundColor: colors.leaf },
  barNow: { backgroundColor: colors.sage },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  copy: { flex: 1, justifyContent: 'center', gap: space.s, maxWidth: 420, paddingVertical: space.m },
  title: { ...type.title, color: colors.leaf },
  hint: { ...type.body, color: colors.sage },
  entry: { alignItems: 'center', gap: space.m },
  message: { ...type.small, color: colors.resin, textAlign: 'center', height: 20 },
  startOver: { minHeight: 44 },
  doneHero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  doneText: { gap: space.s, paddingBottom: space.xl, maxWidth: 420 },
});
