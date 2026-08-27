/**
 * /recording/[id] — Recording Detail Screen
 *
 * Shows: audio playback, editable title, metadata, summary, key takeaways,
 * action items, collapsible transcript. Full CRUD: PATCH for edits, DELETE with
 * confirmation.
 *
 * A missing recording and an unreachable API are different problems and are
 * reported differently — "Recording not found" for a genuine 404, a retry
 * affordance for anything else. The route param is undefined on the first
 * render of a cold deep link, so nothing is fetched until an id exists.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from 'expo-av';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  apiUrl,
  describeRequestError,
  isNonTerminal,
  resolveAudioUrl,
  type ProcessResponse,
  type Recording,
  type RecordingPatch,
  type RecordingStatus,
} from '../../lib/api';

const RED = '#E53935';
const MUTED = '#888';
const BORDER = '#f0f0f0';

/** Playback must not leave the session in record mode, or iOS routes to the earpiece. */
const PLAYBACK_AUDIO_MODE = {
  allowsRecordingIOS: false,
  playsInSilentModeIOS: true,
  staysActiveInBackground: false,
  interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
  interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
};

type LoadError = { kind: 'notFound' } | { kind: 'other'; message: string };

export default function RecordingDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [recording, setRecording] = useState<Recording | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [tick, setTick] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchRecording = useCallback(async (silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/recordings/${id}`));
      if (res.status === 404) {
        if (mountedRef.current) setLoadError({ kind: 'notFound' });
        return;
      }
      if (!res.ok) {
        throw new Error(`Could not load this recording (HTTP ${res.status})`);
      }
      const data = (await res.json()) as Recording;
      if (!mountedRef.current) return;
      setRecording(data);
      setTitleDraft(data.title);
      setNotesDraft(data.notes ?? '');
      setLoadError(null);
    } catch (err) {
      console.error('[detail] fetch failed:', err);
      if (mountedRef.current) {
        setLoadError({ kind: 'other', message: describeRequestError(err, 'Could not load this recording') });
      }
    } finally {
      if (mountedRef.current && !silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchRecording();
  }, [fetchRecording]);

  // Nothing advances a job on the server by itself. While this screen is open on
  // a non-terminal recording it keeps ticking the pipeline, pacing itself with
  // the retry hint the server returns. `tick` re-arms the effect without a
  // spinner-visible refetch.
  useEffect(() => {
    const status = recording?.status;
    if (!id || !status || !isNonTerminal(status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/recordings/${id}/process`), { method: 'POST' });
        if (cancelled || !res.ok) return;
        const result = (await res.json()) as ProcessResponse;
        if (cancelled) return;

        if (result.status !== status) {
          await fetchRecording(true);
          return;
        }
        timer = setTimeout(() => {
          if (!cancelled) setTick((n) => n + 1);
        }, Math.min(Math.max(result.retryAfterMs, 2000), 8000));
      } catch {
        // Self-healing is best-effort; the list screen retries too.
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, recording?.status, tick, fetchRecording]);

  async function patch(fields: RecordingPatch) {
    if (!id) return;
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/recordings/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) throw new Error(`Patch failed (HTTP ${res.status})`);
      const body = (await res.json()) as { success: boolean; recording: Recording };
      if (mountedRef.current && body.recording) setRecording(body.recording);
    } catch (err) {
      Alert.alert('Error', describeRequestError(err, 'Failed to save changes'));
      console.error('[detail] patch failed:', err);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  function handleDelete() {
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
              if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status})`);
              router.back();
            } catch (err) {
              Alert.alert('Error', describeRequestError(err, 'Failed to delete recording'));
              console.error('[detail] delete failed:', err);
            }
          },
        },
      ],
    );
  }

  if (!id || loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={RED} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.mutedText}>
          {loadError.kind === 'notFound' ? 'Recording not found.' : loadError.message}
        </Text>
        {loadError.kind === 'other' && (
          <Pressable style={styles.retryBtn} onPress={() => void fetchRecording()}>
            <Text style={styles.retryBtnText}>Try again</Text>
          </Pressable>
        )}
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
              if (titleDraft !== recording.title) void patch({ title: titleDraft });
            }}
            returnKeyType="done"
            onSubmitEditing={() => {
              setEditingTitle(false);
              if (titleDraft !== recording.title) void patch({ title: titleDraft });
            }}
          />
        </View>
      ) : (
        <Pressable onPress={() => setEditingTitle(true)}>
          <Text style={styles.title}>{recording.title}</Text>
          <Text style={styles.editHint}>Tap to edit title</Text>
        </Pressable>
      )}

      {/* Pipeline status */}
      <StatusBanner status={recording.status} error={recording.error} />

      {/* Playback */}
      <AudioPlayer
        url={resolveAudioUrl(recording.audioUrl)}
        contentType={recording.audioContentType}
      />

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
              if (notesDraft !== recording.notes) void patch({ notes: notesDraft });
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
        onPress={() => router.push(`/recording-chat?recordingId=${id}`)}
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

// ─── Playback ────────────────────────────────────────────────────────────────

/**
 * Web renders a real <audio> element (react-native-web renders to the DOM, so
 * the host component passes straight through). Native uses expo-av's Sound,
 * loaded lazily on the first play so opening the screen costs no network.
 */
function AudioPlayer({ url, contentType }: { url: string; contentType: string }) {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.playerRow}>
        {React.createElement('audio', {
          src: url,
          controls: true,
          preload: 'none',
          style: { width: '100%' },
        })}
      </View>
    );
  }
  return <NativeAudioPlayer url={url} contentType={contentType} />;
}

function NativeAudioPlayer({ url, contentType }: { url: string; contentType: string }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      const sound = soundRef.current;
      soundRef.current = null;
      void sound?.unloadAsync().catch(() => undefined);
    };
  }, [url]);

  async function toggle() {
    setError(null);
    setBusy(true);
    try {
      if (soundRef.current) {
        if (isPlaying) {
          await soundRef.current.pauseAsync();
          setIsPlaying(false);
        } else {
          await soundRef.current.playAsync();
          setIsPlaying(true);
        }
        return;
      }

      await Audio.setAudioModeAsync(PLAYBACK_AUDIO_MODE);
      const { sound } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          setIsPlaying(status.isPlaying);
          if (status.didJustFinish) {
            setIsPlaying(false);
            void sound.setPositionAsync(0).catch(() => undefined);
          }
        },
      );
      soundRef.current = sound;
      setIsPlaying(true);
    } catch (err) {
      setError(
        `Could not play this recording (${contentType}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      setIsPlaying(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.playerRow}>
      <Pressable
        style={styles.playBtn}
        onPress={() => void toggle()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause recording' : 'Play recording'}
      >
        <Text style={styles.playBtnText}>{isPlaying ? '❚❚  Pause' : '▶  Play'}</Text>
      </Pressable>
      {error ? <Text style={styles.playerError}>{error}</Text> : null}
    </View>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const STATUS_LABELS: Record<RecordingStatus, string> = {
  uploaded: 'Queued for transcription',
  transcribing: 'Transcribing…',
  enriching: 'Writing the summary…',
  ready: 'Ready',
  failed: 'Processing failed',
};

function StatusBanner({ status, error }: { status: RecordingStatus; error: string | null }) {
  if (status === 'ready') return null;
  const failed = status === 'failed';
  return (
    <View style={[styles.banner, failed ? styles.bannerFailed : styles.bannerPending]}>
      <Text style={[styles.bannerText, failed && { color: RED }]}>{STATUS_LABELS[status]}</Text>
      {failed && error ? <Text style={styles.bannerDetail}>{error}</Text> : null}
    </View>
  );
}

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
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  mutedText: { color: MUTED, fontSize: 15, textAlign: 'center' },

  retryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#f5f5f5',
  },
  retryBtnText: { color: RED, fontWeight: '600', fontSize: 14 },

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

  banner: { borderRadius: 8, padding: 10, marginBottom: 10 },
  bannerPending: { backgroundColor: '#FFF8E1' },
  bannerFailed: { backgroundColor: RED + '11' },
  bannerText: { fontSize: 13, fontWeight: '600', color: '#8a6d00' },
  bannerDetail: { fontSize: 12, color: '#555', marginTop: 4 },

  playerRow: { marginBottom: 12, gap: 8 },
  playBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#f5f5f5',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 24,
  },
  playBtnText: { fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  playerError: { fontSize: 12, color: RED },

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
