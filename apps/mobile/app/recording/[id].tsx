/**
 * /recording/[id] — Recording Detail Screen
 *
 * Dark-first. Amber on Midnight. Walfly Design System.
 *
 * Shows: audio playback with waveform visualisation & play/pause button,
 * editable title with amber focus underline, status banner, metadata row,
 * tags, summary in obsidian card, horizontally scrollable key takeaways chips,
 * action items with checkbox UI, personal notes editor, collapsible transcript
 * with timestamp markers & monospace styling, per-recording chat shortcut,
 * and delete action with confirmation.
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
import { AudioModule, createAudioPlayer, setAudioModeAsync, type AudioStatus } from 'expo-audio';
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
import { colors, fonts, fontSizes, spacing, radius, shadow } from '../../lib/theme';

/** Playback must not leave the session in record mode, or iOS routes to the earpiece. */
const PLAYBACK_AUDIO_MODE = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: 'mixWithOthers' as const,
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
  const [checkedActions, setCheckedActions] = useState<Record<number, boolean>>({});
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

  // Keep ticking pipeline if recording is in a non-terminal processing state
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
        // Self-healing retry is best-effort
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
      'delete moment',
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

  function toggleAction(index: number) {
    setCheckedActions((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  }

  if (!id || loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.amber} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {loadError.kind === 'notFound' ? 'recording not found' : loadError.message}
        </Text>
        {loadError.kind === 'other' && (
          <Pressable style={styles.retryBtn} onPress={() => void fetchRecording()}>
            <Text style={styles.retryBtnText}>tap to retry</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (!recording) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>recording not found</Text>
      </View>
    );
  }

  const lines = (recording.transcript ?? '').split('\n').filter((l) => l.trim().length > 0);
  const previewLines = lines.slice(0, 6);
  const displayedLines = transcriptExpanded ? lines : previewLines;

  return (
    <View style={styles.screen}>
      {/* Navigation Top Bar */}
      <View style={styles.navBar}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to moments"
        >
          <Text style={styles.backBtnText}>← moments</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.navChatBtn, pressed && styles.pressed]}
          onPress={() => router.push(`/recording-chat?recordingId=${id}`)}
          accessibilityRole="button"
          accessibilityLabel="Chat about this recording"
        >
          <Text style={styles.navChatBtnText}>chat ↗</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Title — Editable inline */}
        {editingTitle ? (
          <View style={styles.editRow}>
            <TextInput
              style={styles.titleInput}
              value={titleDraft}
              onChangeText={setTitleDraft}
              autoFocus
              selectionColor={colors.amber}
              onBlur={() => {
                setEditingTitle(false);
                if (titleDraft.trim() && titleDraft !== recording.title) {
                  void patch({ title: titleDraft.trim() });
                }
              }}
              returnKeyType="done"
              onSubmitEditing={() => {
                setEditingTitle(false);
                if (titleDraft.trim() && titleDraft !== recording.title) {
                  void patch({ title: titleDraft.trim() });
                }
              }}
            />
          </View>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.titleContainer, pressed && styles.pressed]}
            onPress={() => setEditingTitle(true)}
          >
            <Text style={styles.title}>{recording.title}</Text>
            <Text style={styles.editHint}>tap to edit title</Text>
          </Pressable>
        )}

        {/* Status banner (non-ready states) */}
        <StatusBanner status={recording.status} error={recording.error} />

        {/* Metadata row */}
        <View style={styles.metaRow}>
          <MetaChip label={formatDate(recording.createdAt)} />
          {recording.duration ? <MetaChip label={formatDuration(recording.duration)} /> : null}
          {recording.location?.placeName ? (
            <MetaChip label={recording.location.placeName} />
          ) : null}
        </View>

        {/* Tags */}
        {recording.tags && recording.tags.length > 0 && (
          <View style={styles.tagRow}>
            {recording.tags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag.toLowerCase()}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Hero Audio Player with Waveform */}
        <AudioPlayer
          url={resolveAudioUrl(recording.audioUrl)}
          contentType={recording.audioContentType}
          duration={recording.duration}
        />

        {/* Summary Card */}
        {recording.summary ? (
          <View style={styles.summaryCard}>
            <View style={styles.summaryHeader}>
              <View style={styles.summaryDot} />
              <Text style={styles.sectionHeader}>summary</Text>
            </View>
            <Text style={styles.summaryText}>{recording.summary}</Text>
          </View>
        ) : null}

        {/* Key Takeaways — horizontal chips */}
        {recording.keyTakeaways && recording.keyTakeaways.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>key takeaways</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.takeawaysScroll}
            >
              {recording.keyTakeaways.map((item, i) => (
                <View key={i} style={styles.takeawayChip}>
                  <View style={styles.takeawayDot} />
                  <Text style={styles.takeawayText}>{item}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Action Items with Checkbox */}
        {recording.actionItems && recording.actionItems.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>action items</Text>
            <View style={styles.actionItemsList}>
              {recording.actionItems.map((item, i) => {
                const checked = !!checkedActions[i];
                return (
                  <Pressable
                    key={i}
                    style={({ pressed }) => [
                      styles.actionItemRow,
                      pressed && styles.pressed,
                    ]}
                    onPress={() => toggleAction(i)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                  >
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                      {checked && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={[styles.actionText, checked && styles.actionTextChecked]}>
                      {item}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* Personal Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>notes</Text>
          {editingNotes ? (
            <TextInput
              style={styles.notesInput}
              value={notesDraft}
              onChangeText={setNotesDraft}
              placeholder="add thoughts or context…"
              placeholderTextColor={colors.fog}
              multiline
              autoFocus
              selectionColor={colors.amber}
              onBlur={() => {
                setEditingNotes(false);
                if (notesDraft !== (recording.notes ?? '')) {
                  void patch({ notes: notesDraft });
                }
              }}
            />
          ) : (
            <Pressable
              style={({ pressed }) => [styles.notesCard, pressed && styles.pressed]}
              onPress={() => setEditingNotes(true)}
            >
              <Text style={[styles.notesText, !recording.notes && styles.notesPlaceholder]}>
                {recording.notes || 'tap to add notes…'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Collapsible Transcript with Timestamps */}
        {recording.transcript ? (
          <View style={styles.section}>
            <View style={styles.transcriptHeaderRow}>
              <Text style={styles.sectionHeader}>transcript</Text>
              <Text style={styles.transcriptCount}>
                {lines.length} {lines.length === 1 ? 'segment' : 'segments'}
              </Text>
            </View>
            <View style={styles.transcriptContainer}>
              {displayedLines.map((line, index) => (
                <TranscriptLine key={index} line={line} index={index} />
              ))}
            </View>
            {lines.length > 6 && (
              <Pressable
                style={({ pressed }) => [styles.expandBtn, pressed && styles.pressed]}
                onPress={() => setTranscriptExpanded((v) => !v)}
              >
                <Text style={styles.expandBtnText}>
                  {transcriptExpanded ? 'show less ↑' : `show full transcript (${lines.length} lines) ↓`}
                </Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {/* Chat Shortcut Button */}
        <Pressable
          style={({ pressed }) => [styles.chatActionBtn, pressed && styles.pressed]}
          onPress={() => router.push(`/recording-chat?recordingId=${id}`)}
          accessibilityRole="button"
        >
          <Text style={styles.chatActionBtnText}>chat about this moment</Text>
          <Text style={styles.chatActionBtnArrow}>→</Text>
        </Pressable>

        {/* Delete Moment */}
        <Pressable
          style={({ pressed }) => [styles.deleteBtn, pressed && styles.pressed]}
          onPress={handleDelete}
          disabled={saving}
          accessibilityRole="button"
        >
          <Text style={styles.deleteBtnText}>delete moment</Text>
        </Pressable>

        <View style={{ height: spacing['3xl'] }} />
      </ScrollView>
    </View>
  );
}

// ─── Transcript Line ─────────────────────────────────────────────────────────

function TranscriptLine({ line, index }: { line: string; index: number }) {
  // Check if line contains a timestamp like [00:15] or 00:15 or [00:15 - 00:30]
  const tsMatch = line.match(/^(\[?(\d{1,2}:\d{2}(?::\d{2})?(?:\s*-\s*\d{1,2}:\d{2}(?::\d{2})?)?)\]?)(.*)$/);
  if (tsMatch) {
    const timestamp = tsMatch[1].replace(/[\[\]]/g, '');
    const text = tsMatch[3].trim();
    return (
      <View style={styles.transcriptLine}>
        <View style={styles.timestampBadge}>
          <Text style={styles.timestampText}>{timestamp}</Text>
        </View>
        <Text style={styles.transcriptBody}>{text}</Text>
      </View>
    );
  }

  return (
    <View style={styles.transcriptLine}>
      <Text style={styles.transcriptLineIndex}>{String(index + 1).padStart(2, '0')}</Text>
      <Text style={styles.transcriptBody}>{line}</Text>
    </View>
  );
}

// ─── Playback ────────────────────────────────────────────────────────────────

const WAVEFORM_BAR_HEIGHTS = [
  8, 14, 22, 10, 18, 28, 16, 24, 32, 20, 26, 12, 18, 30, 22, 14,
  20, 28, 16, 10, 24, 32, 18, 26, 14, 22, 30, 16, 12, 20, 28, 10,
];

function AudioPlayer({
  url,
  contentType,
  duration,
}: {
  url: string;
  contentType: string;
  duration?: number;
}) {
  if (Platform.OS === 'web') {
    return (
      <View style={styles.heroPlayerCard}>
        <View style={styles.waveformContainer}>
          {WAVEFORM_BAR_HEIGHTS.map((h, i) => (
            <View
              key={i}
              style={[
                styles.waveformBar,
                { height: h, backgroundColor: i < 12 ? colors.amber : colors.border },
              ]}
            />
          ))}
        </View>
        <View style={styles.webAudioWrapper}>
          {React.createElement('audio', {
            src: url,
            controls: true,
            preload: 'none',
            style: { width: '100%', height: 36 },
          })}
        </View>
      </View>
    );
  }
  return <NativeAudioPlayer url={url} contentType={contentType} duration={duration} />;
}

function NativeAudioPlayer({
  url,
  contentType,
  duration,
}: {
  url: string;
  contentType: string;
  duration?: number;
}) {
  const playerRef = useRef<InstanceType<typeof AudioModule['AudioPlayer']> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalDuration = duration || 0;

  useEffect(() => {
    return () => {
      const player = playerRef.current;
      playerRef.current = null;
      player?.remove();
    };
  }, [url]);

  async function toggle() {
    setError(null);
    setBusy(true);
    try {
      if (playerRef.current) {
        if (isPlaying) {
          playerRef.current.pause();
          setIsPlaying(false);
        } else {
          playerRef.current.play();
          setIsPlaying(true);
        }
        return;
      }

      await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
      const player = createAudioPlayer(url);
      player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
        setIsPlaying(status.playing);
        if (status.currentTime) setCurrentTime(status.currentTime);
        if (!status.playing && status.currentTime > 0 && status.currentTime >= status.duration) {
          setIsPlaying(false);
          setCurrentTime(0);
          void player.seekTo(0).catch(() => undefined);
        }
      });
      playerRef.current = player;
      player.play();
      setIsPlaying(true);
    } catch (err) {
      setError(
        `Could not play audio (${contentType}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      setIsPlaying(false);
    } finally {
      setBusy(false);
    }
  }

  const progressFraction = totalDuration > 0 ? Math.min(currentTime / totalDuration, 1) : 0;
  const activeBars = Math.floor(progressFraction * WAVEFORM_BAR_HEIGHTS.length);

  return (
    <View style={styles.heroPlayerCard}>
      {/* Waveform graphic */}
      <View style={styles.waveformContainer}>
        {WAVEFORM_BAR_HEIGHTS.map((h, i) => {
          const isBarActive = isPlaying ? i <= activeBars : false;
          return (
            <View
              key={i}
              style={[
                styles.waveformBar,
                {
                  height: h,
                  backgroundColor: isBarActive ? colors.amber : colors.border,
                },
              ]}
            />
          );
        })}
      </View>

      {/* Controls row */}
      <View style={styles.playerControls}>
        <Pressable
          style={({ pressed }) => [
            styles.heroPlayBtn,
            isPlaying && styles.heroPlayBtnActive,
            pressed && styles.pressed,
          ]}
          onPress={() => void toggle()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? 'Pause recording' : 'Play recording'}
        >
          <Text style={styles.heroPlayIcon}>{isPlaying ? '❚❚' : '▶'}</Text>
        </Pressable>

        <View style={styles.playerInfo}>
          <Text style={styles.playerTimeText}>
            {formatDuration(currentTime)} / {formatDuration(totalDuration)}
          </Text>
          <Text style={styles.playerStatusText}>
            {isPlaying ? 'playing…' : 'tap to listen'}
          </Text>
        </View>
      </View>

      {error ? <Text style={styles.playerError}>{error}</Text> : null}
    </View>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

const STATUS_LABELS: Record<RecordingStatus, string> = {
  uploaded:     'queued for transcription',
  transcribing: 'transcribing…',
  enriching:    'writing summary…',
  ready:        'ready',
  failed:       'processing failed',
};

function StatusBanner({ status, error }: { status: RecordingStatus; error: string | null }) {
  if (status === 'ready') return null;
  const failed = status === 'failed';
  return (
    <View style={[styles.banner, failed ? styles.bannerFailed : styles.bannerPending]}>
      <Text style={[styles.bannerText, failed ? styles.bannerTextFailed : styles.bannerTextPending]}>
        {STATUS_LABELS[status]}
      </Text>
      {failed && error ? <Text style={styles.bannerDetail}>{error}</Text> : null}
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.midnight,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.midnight,
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.mist,
  },
  pressed: {
    opacity: 0.75,
  },

  // Navigation
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  backBtn: {
    paddingVertical: spacing.xs,
  },
  backBtnText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.base,
    color: colors.amber,
  },
  navChatBtn: {
    backgroundColor: colors.amberSubtle,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.amberGlow,
  },
  navChatBtnText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.xs,
    color: colors.amber,
  },

  retryBtn: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.charcoal,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retryBtnText: {
    fontFamily: fonts.bodyMed,
    color: colors.amber,
    fontSize: fontSizes.sm,
  },

  // Title
  titleContainer: {
    gap: 2,
  },
  title: {
    fontFamily: fonts.title,
    fontSize: fontSizes.xxl,
    color: colors.cream,
    letterSpacing: 0.5,
  },
  editHint: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.fog,
  },
  editRow: {
    marginBottom: spacing.xxs,
  },
  titleInput: {
    fontFamily: fonts.title,
    fontSize: fontSizes.xxl,
    color: colors.cream,
    borderBottomWidth: 2,
    borderBottomColor: colors.amber,
    paddingBottom: 4,
  },

  // Status Banner
  banner: {
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
  },
  bannerPending: {
    backgroundColor: colors.amberSubtle,
    borderColor: colors.amberGlow,
  },
  bannerFailed: {
    backgroundColor: colors.errorSubtle,
    borderColor: colors.error,
  },
  bannerText: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.sm,
  },
  bannerTextPending: {
    color: colors.amber,
  },
  bannerTextFailed: {
    color: colors.error,
  },
  bannerDetail: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.mist,
    marginTop: 4,
  },

  // Metadata
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  metaChip: {
    backgroundColor: colors.obsidian,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metaChipText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.mist,
  },

  // Tags
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  tag: {
    backgroundColor: colors.amberSubtle,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.amberGlow,
  },
  tagText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.xs,
    color: colors.amber,
  },

  // Hero Audio Player
  heroPlayerCard: {
    backgroundColor: colors.obsidian,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.md,
    ...shadow.sm,
  },
  waveformContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 36,
    paddingHorizontal: spacing.xs,
  },
  waveformBar: {
    width: 3,
    borderRadius: 2,
  },
  playerControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  heroPlayBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.md,
  },
  heroPlayBtnActive: {
    backgroundColor: colors.amberDim,
    ...shadow.glow,
  },
  heroPlayIcon: {
    fontSize: fontSizes.base,
    color: colors.midnight,
    fontFamily: fonts.bold,
  },
  playerInfo: {
    flex: 1,
    gap: 2,
  },
  playerTimeText: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.base,
    color: colors.cream,
  },
  playerStatusText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.mist,
  },
  playerError: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.error,
  },
  webAudioWrapper: {
    width: '100%',
  },

  // Section
  section: {
    gap: spacing.xs,
  },
  sectionHeader: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.xs,
    color: colors.mist,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },

  // Summary Card
  summaryCard: {
    backgroundColor: colors.obsidian,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  summaryDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  summaryText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    lineHeight: 22,
  },

  // Key Takeaways Chips (Horizontal)
  takeawaysScroll: {
    gap: spacing.xs,
    paddingVertical: spacing.xxs,
  },
  takeawayChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.charcoal,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 280,
  },
  takeawayDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  takeawayText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.cream,
    lineHeight: 18,
    flexShrink: 1,
  },

  // Action Items
  actionItemsList: {
    gap: spacing.xs,
  },
  actionItemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.obsidian,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.fog,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.amber,
    borderColor: colors.amber,
  },
  checkmark: {
    fontSize: fontSizes.xs,
    color: colors.midnight,
    fontFamily: fonts.bold,
  },
  actionText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    flex: 1,
    lineHeight: 22,
  },
  actionTextChecked: {
    color: colors.mist,
    textDecorationLine: 'line-through',
  },

  // Notes
  notesCard: {
    backgroundColor: colors.charcoal,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    minHeight: 70,
  },
  notesText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    lineHeight: 22,
  },
  notesPlaceholder: {
    color: colors.fog,
  },
  notesInput: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    lineHeight: 22,
    backgroundColor: colors.charcoal,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.amber,
    padding: spacing.md,
    minHeight: 90,
  },

  // Transcript
  transcriptHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  transcriptCount: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.fog,
  },
  transcriptContainer: {
    backgroundColor: colors.obsidian,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  transcriptLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
    paddingVertical: 2,
  },
  timestampBadge: {
    backgroundColor: colors.charcoal,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    marginTop: 2,
  },
  timestampText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: fontSizes.xs,
    color: colors.amber,
  },
  transcriptLineIndex: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: fontSizes.xs,
    color: colors.fog,
    width: 24,
    marginTop: 2,
  },
  transcriptBody: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.cream,
    lineHeight: 20,
    flex: 1,
  },
  expandBtn: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
  },
  expandBtnText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.sm,
    color: colors.amber,
  },

  // Chat Action
  chatActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.charcoal,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  chatActionBtnText: {
    fontFamily: fonts.bodyMed,
    fontSize: fontSizes.base,
    color: colors.cream,
  },
  chatActionBtnArrow: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.lg,
    color: colors.amber,
  },

  // Delete
  deleteBtn: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  deleteBtnText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.sm,
    color: colors.error,
  },
});
