import { Redirect, router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { base64_variants, to_base64, to_string } from 'react-native-libsodium';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { writeTemp } from '../../lib/disk';
import { loadIndex, readFile, type Entry } from '../../lib/files';
import { formatBytes } from '../../lib/format';
import { useSession, withAutoLockSuspended } from '../../lib/session';
import { colors, space, type } from '../../lib/theme';

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml))/;

export default function FileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || !id) return;
    let alive = true;
    let data: Uint8Array | null = null;
    (async () => {
      try {
        const found = (await loadIndex(session)).find((e) => e.id === id);
        if (!found) throw new Error('missing');
        data = await readFile(session, id);
        if (alive) {
          setEntry(found);
          setBytes(data);
        }
      } catch {
        if (alive) setError('This file could not be opened.');
      }
    })();
    return () => {
      alive = false;
      data?.fill(0);   // the decrypted file leaves memory with the screen
    };
  }, [session, id]);

  const isImage = !!entry && entry.mime.startsWith('image/');
  const isText = !!entry && TEXT_TYPES.test(entry.mime);

  // A data URI is a second, unzeroable copy of the image in memory. See README.
  const imageUri = useMemo(
    () => (isImage && bytes && entry ? `data:${entry.mime};base64,${to_base64(bytes, base64_variants.ORIGINAL)}` : null),
    [isImage, bytes, entry],
  );
  const text = useMemo(() => (isText && bytes ? to_string(bytes) : null), [isText, bytes]);

  if (!session) return <Redirect href="/" />;

  const exportFile = () => {
    if (!entry || !bytes) return;
    Alert.alert(
      'Export this file?',
      'A readable copy is written to the app’s temporary folder while the share sheet is open, then deleted. Deleted data can sometimes be recovered from storage.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Export',
          onPress: () =>
            void withAutoLockSuspended(async () => {
              setBusy(true);
              let temp: Awaited<ReturnType<typeof writeTemp>> | null = null;
              try {
                temp = await writeTemp(entry.name, bytes);
                await Sharing.shareAsync(temp.uri, { mimeType: entry.mime, dialogTitle: entry.name });
              } catch {
                setError('The file could not be exported.');
              } finally {
                try {
                  temp?.delete();
                } catch {
                  // already gone
                }
                setBusy(false);
              }
            }),
        },
      ],
    );
  };

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <Button title="Back" variant="quiet" onPress={() => router.back()} style={styles.headerButton} />
        <Text style={styles.name} numberOfLines={1}>
          {entry?.name ?? ''}
        </Text>
        <Button
          title="Export"
          variant="quiet"
          onPress={exportFile}
          disabled={!bytes}
          busy={busy}
          style={styles.headerButton}
        />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.notice}>{error}</Text>
        </View>
      ) : !bytes || !entry ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.leaf} />
        </View>
      ) : imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" accessibilityLabel={entry.name} />
      ) : text !== null ? (
        <ScrollView contentContainerStyle={styles.textWrap}>
          <Text style={styles.text}>{text}</Text>
        </ScrollView>
      ) : (
        <View style={styles.center}>
          <Text style={styles.noPreviewTitle}>No preview for this type.</Text>
          <Text style={styles.notice}>
            {formatBytes(entry.size)}. Use Export to open it in another app.
          </Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    paddingHorizontal: space.s,
    paddingTop: space.xs,
    paddingBottom: space.s,
  },
  headerButton: { minHeight: 44, paddingHorizontal: space.m },
  name: { ...type.bodyMedium, color: colors.leaf, flex: 1, textAlign: 'center' },
  image: { flex: 1, marginHorizontal: space.m, marginBottom: space.l },
  textWrap: { padding: space.l },
  text: { ...type.body, color: colors.leaf },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.s, padding: space.l },
  noPreviewTitle: { ...type.bodyMedium, color: colors.leaf },
  notice: { ...type.small, color: colors.sage, textAlign: 'center' },
});
