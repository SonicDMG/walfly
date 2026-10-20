/**
 * ApiTokenGate
 *
 * Blocks the app behind a one-time prompt for the shared API bearer token
 * when none is stored on-device yet (apiFetch in lib/api.ts attaches it to
 * every request). There is no accounts system here — this is the entire
 * auth UI.
 */

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { getApiToken, setApiToken } from '../lib/api';
import { colors, fonts, fontSizes, radius, spacing } from '../lib/theme';

export function ApiTokenGate({ children }: { children: React.ReactNode }) {
  // undefined = still reading SecureStore; null = no token stored yet.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getApiToken().then(setToken);
  }, []);

  async function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSaving(true);
    await setApiToken(trimmed);
    setSaving(false);
    setDraft('');
    setToken(trimmed);
  }

  if (token === undefined) return null;

  return (
    <>
      {children}
      <Modal visible={token === null} animationType="fade" transparent>
        <View style={styles.backdrop}>
          <View style={styles.card}>
            <Text style={styles.title}>Server token</Text>
            <Text style={styles.body}>
              Enter the WALFLY_API_TOKEN configured on your Walfly server.
            </Text>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Paste token"
              placeholderTextColor={colors.fog}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              onSubmitEditing={handleSave}
            />
            <Pressable
              style={[styles.button, (!draft.trim() || saving) && styles.buttonDisabled]}
              onPress={handleSave}
              disabled={!draft.trim() || saving}
            >
              <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save'}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(13, 13, 15, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.charcoal,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  title: {
    fontFamily: fonts.title,
    fontSize: fontSizes.lg,
    color: colors.cream,
    marginBottom: spacing.xs,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.mist,
    marginBottom: spacing.md,
  },
  input: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    backgroundColor: colors.obsidian,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  },
  button: {
    backgroundColor: colors.amber,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.base,
    color: colors.midnight,
  },
});
