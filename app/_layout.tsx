import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  useFonts,
} from '@expo-google-fonts/instrument-sans';
import { Stack, router } from 'expo-router';
import { enableAppSwitcherProtectionAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { sweepPlaintextCache } from '../lib/disk';
import { getSession, isAutoLockSuspended, lock, lockIfAwayTooLong } from '../lib/session';
import { colors } from '../lib/theme';

void SplashScreen.preventAutoHideAsync();

/**
 * Turns on screen-capture blocking, retrying until it holds. On iOS the block attaches to the key
 * window, which may not exist yet at the first render (the call then fails); it is also re-applied
 * on every return to the foreground, in case the key window changed.
 */
function protectScreen(attempt = 0): void {
  preventScreenCaptureAsync('cube').catch(() => {
    if (attempt < 20) setTimeout(() => protectScreen(attempt + 1), 250);
  });
}

export default function RootLayout() {
  // One app-wide screen-capture block, never lifted. Per-screen hooks shared the "default" key,
  // so leaving the file viewer re-allowed capture on the list. The lock and setup screens are
  // covered too (the keypad highlights each pressed digit). No cleanup on purpose: a hook's
  // cleanup would re-allow capture, and it fails anyway when Android has already destroyed the
  // activity. On Android, plugins/withSecureWindow.js also sets the flag natively.
  useEffect(() => {
    protectScreen();
    // iOS takes a snapshot of the app for the app switcher; blur it fully so an open vault never
    // shows there. (Android: FLAG_SECURE already blanks the app in Recents.)
    if (Platform.OS === 'ios') enableAppSwitcherProtectionAsync(1).catch(() => undefined);
    // Picker or export copies left behind if the app was killed mid-add or mid-export. (Not while
    // a picker is up: Android can recreate this layout while one is still delivering its copy.)
    if (!isAutoLockSuspended()) sweepPlaintextCache();
  }, []);

  const [fontsReady] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
  });

  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  // Leaving the app locks the vault — unless a picker or share sheet we opened is up, and then
  // only for a limited time: coming back after longer than that finds the vault locked.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && getSession() && !isAutoLockSuspended()) {
        lock();
        router.replace('/');
      } else if (state === 'active') {
        protectScreen();
        if (lockIfAwayTooLong()) router.replace('/');
      }
    });
    return () => sub.remove();
  }, []);

  if (!fontsReady) return null;

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          contentStyle: { backgroundColor: colors.frost },
        }}
      />
    </>
  );
}
