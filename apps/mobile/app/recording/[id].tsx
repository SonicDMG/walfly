/**
 * /recording/[id] — Recording Detail Screen
 *
 * Shows: editable title, metadata, summary, key takeaways, action items,
 * collapsible transcript. Full CRUD: PATCH for edits, DELETE with confirmation.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { apiUrl } from '../../lib/api';
import type { Recording } from '@walfly/db';

const RED = '#E53935';
const MUTED = '#888';
const BORDER = '#f0f0f0';

export default function RecordingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [recording, setRecording] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(true);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchRecording = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/recordings/${id}`));
      if (!res.ok) return;
      const data = (await res.json()) as Recording;
      setRecording(data);
      setTitleDraft(data.title);
      setNotesDraft(data.notes ?? '');
    } catch (err) {
      console.error('[detail] fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchRecording();
  }, [fetchRecording]);

  async function patch(fields: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/recordings/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error('Patch failed');
      // Optimistic: update local state
      setRecording((prev) => prev ? { ...prev, ...fields } as Recording : prev);
    } catch (err) {
      Alert.alert('Error', 'Failed to save changes');
      console.error('[detail] patch failed:', err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    Alert.alert(
      'Delete recording',
      'This will permanently delete the recording and its audio. Are you sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await fetch(apiUrl(`/api/recordings/${id}`), { method: 'DELETE' });
              if (!res.ok) throw new Error('Delete failed');
              router.back();
            } catch (err) {
              Alert.alert('Error', 'Failed to delete recording');
              console.error('[detail] delete failed:', err);
            }
          },
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={RED} />
      </View>
    );
  }

  if (!recording) {
    return (
      <View style={styles.centered}>
        <Text style={styles.mutedText}>Recording not found.</Text>
      </View>
    );
  }

  const lines = (recording.transcript ?? '').split('\n');
  const previewLines = lines.slice(0, 6).join('\n');

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      {/* Title */}
      {editingTitle ? (
        <View style={styles.editRow}>
          <TextInput
            style={styles.titleInput}
            value={titleDraft}
            onChangeText={setTitleDraft}
            autoFocus
            onBlur={() => {
              setEditingTitle(false);
              if (titleDraft !== recording.title) {
                void patch({ title: titleDraft });
              }
            }}
            returnKeyType="done"
            onSubmitEditing={() => {
              setEditingTitle(false);
              if (titleDraft !== recording.title) {
                void patch({ title: titleDraft });
              }
            }}
          />
        </View>
      ) : (
        <Pressable onPress={() => setEditingTitle(true)}>
          <Text style={styles.title}>{recording.title}</Text>
          <Text style={styles.editHint}>Tap to edit title</Text>
        </Pressable>
      )}

      {/* Metadata */}
      <View style={styles.metaRow}>
        <MetaChip label={formatDate(recording.createdAt)} />
        {recording.duration ? <MetaChip label={formatDuration(recording.duration)} /> : null}
        {recording.location?.placeName ? (
          <MetaChip label={recording.location.placeName} />
        ) : null}
      </View>

      {/* Tags */}
      {recording.tags.length > 0 && (
        <View style={styles.tagRow}>
          {recording.tags.map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      )}

      <Divider />

      {/* Summary */}
      {recording.summary && (
        <Section title="Summary">
          <Text style={styles.bodyText}>{recording.summary}</Text>
        </Section>
      )}

      {/* Key Takeaways */}
      {recording.keyTakeaways.length > 0 && (
        <Section title="Key Takeaways">
          {recording.keyTakeaways.map((item, i) => (
            <BulletItem key={i} text={item} />
          ))}
        </Section>
      )}

      {/* Action Items */}
      {recording.actionItems.length > 0 && (
        <Section title="Action Items">
          {recording.actionItems.map((item, i) => (
            <BulletItem key={i} text={item} icon="☐" />
          ))}
        </Section>
      )}

      {/* Notes */}
      <Section title="Notes">
        {editingNotes ? (
          <TextInput
            style={styles.notesInput}
            value={notesDraft}
            onChangeText={setNotesDraft}
            multiline
            autoFocus
            onBlur={() => {
              setEditingNotes(false);
              if (notesDraft !== recording.notes) {
                void patch({ notes: notesDraft });
              }
            }}
          />
        ) : (
          <Pressable onPress={() => setEditingNotes(true)}>
            <Text style={[styles.bodyText, !recording.notes && { color: MUTED }]}>
              {recording.notes || 'Tap to add notes…'}
            </Text>
          </Pressable>
        )}
      </Section>

      <Divider />

      {/* Transcript */}
      {recording.transcript && (
        <Section title="Transcript">
          <Text style={styles.transcriptText}>
            {transcriptExpanded ? recording.transcript : previewLines}
          </Text>
          <Pressable
            style={styles.expandBtn}
            onPress={() => setTranscriptExpanded((v) => !v)}
          >
            <Text style={styles.expandBtnText}>
              {transcriptExpanded ? 'Show less ↑' : 'Show full transcript ↓'}
            </Text>
          </Pressable>
        </Section>
      )}

      <Divider />

      {/* Chat link */}
      <Pressable
        style={styles.chatBtn}
        onPress={() => router.push(`/chat?recordingId=${id}`)}
      >
        <Text style={styles.chatBtnText}>💬  Chat about this recording</Text>
      </Pressable>

      {/* Delete */}
      <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={saving}>
        <Text style={styles.deleteBtnText}>Delete recording</Text>
      </Pressable>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function BulletItem({ text, icon = '•' }: { text: string; icon?: string }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletIcon}>{icon}</Text>
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

function MetaChip({ label }: { label: string }) {
  return (
    <View style={styles.metaChip}>
      <Text style={styles.metaChipText}>{label}</Text>
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mutedText: { color: MUTED, fontSize: 15 },

  title: { fontSize: 22, fontWeight: '700', color: '#1a1a1a', marginBottom: 2 },
  editHint: { fontSize: 11, color: MUTED, marginBottom: 8 },
  editRow: { marginBottom: 8 },
  titleInput: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    borderBottomWidth: 2,
    borderBottomColor: RED,
    paddingBottom: 2,
  },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 },
  metaChip: {
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  metaChipText: { fontSize: 12, color: '#555' },

  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tag: { backgroundColor: RED + '22', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  tagText: { fontSize: 12, color: RED, fontWeight: '500' },

  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: MUTED, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 },

  bodyText: { fontSize: 15, color: '#333', lineHeight: 22 },

  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  bulletIcon: { fontSize: 15, color: MUTED, marginRight: 8, marginTop: 1 },
  bulletText: { fontSize: 15, color: '#333', flex: 1, lineHeight: 22 },

  notesInput: {
    fontSize: 15,
    color: '#333',
    lineHeight: 22,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 10,
    minHeight: 80,
  },

  transcriptText: { fontSize: 13, color: '#555', lineHeight: 20, fontFamily: 'monospace' },
  expandBtn: { marginTop: 8 },
  expandBtnText: { color: RED, fontSize: 13, fontWeight: '600' },

  divider: { height: 1, backgroundColor: BORDER, marginVertical: 16 },

  chatBtn: {
    backgroundColor: '#f0f4ff',
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  chatBtnText: { color: '#3b5bdb', fontWeight: '600', fontSize: 15 },

  deleteBtn: { padding: 14, alignItems: 'center' },
  deleteBtnText: { color: RED, fontSize: 14 },
});
