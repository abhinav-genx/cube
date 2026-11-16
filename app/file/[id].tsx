import { Redirect, router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, Text, View, type ViewProps } from 'react-native';
import { base64_variants, to_base64, to_string } from 'react-native-libsodium';
import { Button } from '../../components/Button';
import { Screen } from '../../components/Screen';
import { exportSink, newExportFile, removeExports } from '../../lib/disk';
import CubeNative, { CubeImageView } from '../../modules/cube-native';
import { exportTo, fileAccess, readFile, type Entry } from '../../lib/files';
import { formatBytes } from '../../lib/format';
import { getSession, useSession, withAutoLockSuspended } from '../../lib/session';
import { colors, space, type } from '../../lib/theme';

/** An image or text decrypted in native code (modules/cube-native), shown by handle. */
function NativeView(props: { handle: number; textColor?: string; fontSize?: number } & ViewProps) {
  const Native = CubeImageView();
  return <Native {...props} />;
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml))/;
const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;   // longer text files show their start, with a note

export default function FileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const session = useSession();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  // Images and text open natively where possible: the decrypted file never enters JavaScript.
  const [nativeHandle, setNativeHandle] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);   // preview attempt finished (shown, or no preview)
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session || !id) return;
    let alive = true;
    let data: Uint8Array | null = null;
    let handle: number | null = null;
    (async () => {
      try {
        const access = await fileAccess(session, id);
        const { entry: found } = access;
        const image = found.mime.startsWith('image/');
        const text = TEXT_TYPES.test(found.mime);
        try {
          if ((image || text) && CubeNative?.nativePreviewAvailable()) {
            try {
              handle = image
                ? CubeNative.openImage(access.uri, access.key, access.format)
                : CubeNative.openText(access.uri, access.key, access.format, TEXT_PREVIEW_BYTES);
            } catch {
              handle = null;   // not decodable natively: fall back to the JavaScript path
            }
          }
        } finally {
          access.key.fill(0);
        }
        if (handle === null && (image || text)) data = await readFile(session, id);
        if (alive) {
          setEntry(found);
          if (handle !== null) setNativeHandle(handle);
          else setBytes(data);
          setOpened(true);
        } else if (handle !== null) {
          CubeNative?.closeImage(handle);
        }
      } catch {
        if (alive) setError('This file could not be opened.');
      }
    })();
    return () => {
      alive = false;
      data?.fill(0);   // the decrypted file leaves memory with the screen
      if (handle !== null) CubeNative?.closeImage(handle);
    };
  }, [session, id]);

  const isImage = !!entry && entry.mime.startsWith('image/');
  const isText = !!entry && TEXT_TYPES.test(entry.mime);

  // A data URI is a second, unzeroable copy of the image in memory. See README.
  const imageUri = useMemo(
    () => (isImage && bytes && entry ? `data:${entry.mime};base64,${to_base64(bytes, base64_variants.ORIGINAL)}` : null),
    [isImage, bytes, entry],
  );
  const text = useMemo(() => (isText && bytes ? to_string(bytes.subarray(0, TEXT_PREVIEW_BYTES)) : null), [isText, bytes]);

  if (!session) return <Redirect href="/" />;

  /** Writes the readable copy for the share sheet: natively where possible, else streamed from JavaScript. */
  const writeExport = async (e: Entry) => {
    const s = getSession();
    if (!s) throw new Error('locked');
    const file = newExportFile(e.name);
    if (CubeNative?.nativePreviewAvailable()) {
      const access = await fileAccess(s, e.id);
      let job: number;
      try {
        job = CubeNative.prepareExport(access.uri, access.key, access.format);
      } finally {
        access.key.fill(0);
      }
      await CubeNative.runExport(job, file.uri);
    } else {
      await exportTo(s, e.id, exportSink(file));
    }
    return file;
  };

  const exportFile = () => {
    if (!entry || !opened) return;
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
              try {
                const file = await writeExport(entry);
                await Sharing.shareAsync(file.uri, { mimeType: entry.mime, dialogTitle: entry.name });
              } catch {
                setError('The file could not be exported.');
              } finally {
                removeExports();   // the readable copy goes as soon as the share sheet closes
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
          disabled={!opened}
          busy={busy}
          style={styles.headerButton}
        />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.notice}>{error}</Text>
        </View>
      ) : entry && nativeHandle !== null ? (
        <NativeView
          handle={nativeHandle}
          textColor={colors.leaf}
          fontSize={type.body.fontSize}
          style={isImage ? styles.image : styles.nativeText}
          accessibilityLabel={entry.name}
        />
      ) : !opened || !entry ? (
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
  nativeText: { flex: 1 },
  textWrap: { padding: space.l },
  text: { ...type.body, color: colors.leaf },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.s, padding: space.l },
  noPreviewTitle: { ...type.bodyMedium, color: colors.leaf },
  notice: { ...type.small, color: colors.sage, textAlign: 'center' },
});
