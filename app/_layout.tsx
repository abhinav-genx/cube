import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  useFonts,
} from '@expo-google-fonts/instrument-sans';
import { Stack, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { getSession, isAutoLockSuspended, lock } from '../lib/session';
import { colors } from '../lib/theme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsReady] = useFonts({
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
  });

  useEffect(() => {
    if (fontsReady) void SplashScreen.hideAsync();
  }, [fontsReady]);

  // Leaving the app locks the vault — unless a picker or share sheet we opened is up.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && getSession() && !isAutoLockSuspended()) {
        lock();
        router.replace('/');
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
