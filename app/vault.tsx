import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Redirect, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button';
import { Logo } from '../components/Logo';
import { Screen } from '../components/Screen';
import { deleteUri, openUri, readUri } from '../lib/disk';
import { addFile, addFileFrom, loadIndex, removeFile, tidy, upgradeOldFiles, type Entry } from '../lib/files';
import { formatBytes, formatDate, kindOf } from '../lib/format';
import { getSession, lock, useSession, withAutoLockSuspended } from '../lib/session';
import { stripImageMetadata } from '../lib/strip';
import { colors, radius, space, type } from '../lib/theme';

type Picked = { uri: string; name: string; mime: string };

async function pickImage(): Promise<Picked | null> {
  // Android's photo picker reports a media ID ("21.png") instead of the file's name, so on
  // Android photos go through the system file picker filtered to images, which keeps real names.
  if (Platform.OS === 'android') return pickDocument('image/*');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  if (r.canceled) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.fileName ?? `photo-${Date.now()}.jpg`, mime: a.mimeType ?? 'image/jpeg' };
}

async function pickDocument(type: string = '*/*'): Promise<Picked | null> {
  // Android: read the picked document where it is (content://) instead of through a plaintext
  // copy in the cache. iOS always hands over a copy.
  const r = await DocumentPicker.getDocumentAsync({
    type,
    copyToCacheDirectory: Platform.OS !== 'android',
    multiple: false,
  });
  if (r.canceled) return null;
  const a = r.assets[0];
  return { uri: a.uri, name: a.name, mime: a.mimeType ?? 'application/octet-stream' };
}

export default function VaultScreen() {
  const session = useSession();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    loadIndex(session)
      .then((list) => {
        if (alive) setEntries(list);
        // Finish interrupted adds/deletes and even out filler, then move a few files from the old
        // format to per-file keys (a little each unlock; nothing to do once all are upgraded).
        void tidy(session)
          .then(() => upgradeOldFiles(session))
          .catch(() => undefined);
      })
      .catch(() => alive && setNotice('The file list could not be read.'));
    return () => {
      alive = false;
    };
  }, [session]);

  if (!session) return <Redirect href="/" />;

  const doLock = () => {
    lock();
    router.replace('/');
  };

  const add = () =>
    Alert.alert('Add a file', undefined, [
      { text: 'Photo', onPress: () => void pick(pickImage) },
      { text: 'Document', onPress: () => void pick(pickDocument) },
      { text: 'Cancel', style: 'cancel' },
    ]);

  const pick = async (picker: () => Promise<Picked | null>) => {
    setBusy(true);
    setNotice(null);
    let picked: Picked | null = null;
    try {
      picked = await withAutoLockSuspended(picker);
      if (!picked) return;
      const s = getSession();
      if (!s) return;
      let next: Entry[];
      if (picked.mime.startsWith('image/')) {
        // Photos lose their location and camera details before they are stored (and exported).
        const raw = await readUri(picked.uri);
        const bytes = stripImageMetadata(raw);
        if (bytes !== raw) raw.fill(0);
        try {
          next = await addFile(s, picked.name, picked.mime, bytes);
        } finally {
          bytes.fill(0);
        }
      } else {
        // Anything else is streamed in 64 KiB pieces, so its size is limited only by storage.
        const src = openUri(picked.uri);
        try {
          next = await addFileFrom(s, picked.name, picked.mime, src);
        } finally {
          src.close();
        }
      }
      setEntries(next);
    } catch {
      setNotice('That file could not be added.');
    } finally {
      if (picked) deleteUri(picked.uri);   // the picker's plaintext copy (never an original document)
      setBusy(false);
    }
  };

  const confirmDelete = (e: Entry) =>
    Alert.alert(`Delete “${e.name}”?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const s = getSession();
          if (!s) return;
          removeFile(s, e.id)
            .then(setEntries)
            .catch(() => setNotice('That file could not be deleted.'));
        },
      },
    ]);

  return (
    <Screen padded={false}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Logo size={30} />
          <Text style={styles.title}>Files</Text>
        </View>
        <Button title="Lock" variant="quiet" onPress={doLock} style={styles.lock} />
      </View>

      <FlatList
        data={entries ?? []}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          entries === null ? undefined : (
            <Text style={styles.empty}>No files yet. Add one with the button below.</Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/file/${item.id}`)}
            onLongPress={() => confirmDelete(item)}
            accessibilityRole="button"
            accessibilityHint="Long press to delete"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.kind}>
              <Text style={styles.kindText} numberOfLines={1}>
                {kindOf(item.name, item.mime)}
              </Text>
            </View>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.meta}>
                {formatBytes(item.size)}, added {formatDate(item.addedAt)}
              </Text>
            </View>
          </Pressable>
        )}
      />

      <View style={styles.footer}>
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Button title="Add file" onPress={add} busy={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.l,
    paddingTop: space.s,
    paddingBottom: space.m,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  title: { ...type.title, color: colors.leaf },
  lock: { minHeight: 44, paddingHorizontal: space.m },
  list: { paddingHorizontal: space.m, paddingBottom: space.m, gap: 4 },
  empty: { ...type.body, color: colors.sage, textAlign: 'center', paddingTop: space.xxl, paddingHorizontal: space.l },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.m,
    paddingVertical: space.s + 4,
    paddingHorizontal: space.s,
    borderRadius: radius.row,
  },
  rowPressed: { backgroundColor: colors.mist },
  kind: {
    width: 48,
    height: 48,
    borderRadius: 10,
    backgroundColor: colors.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindText: { ...type.small, color: colors.leaf },
  rowText: { flex: 1, gap: 2 },
  name: { ...type.bodyMedium, color: colors.leaf },
  meta: { ...type.small, color: colors.sage },
  footer: { paddingHorizontal: space.l, paddingTop: space.s, gap: space.s },
  notice: { ...type.small, color: colors.resin, textAlign: 'center' },
});
