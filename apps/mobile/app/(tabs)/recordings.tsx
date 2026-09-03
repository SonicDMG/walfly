/**
 * Tab 2 — Moments (My Recordings)
 *
 * Dark-first card list. Amber accents, Fraunces titles.
 * The pipeline self-healing ticker is preserved exactly.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  apiUrl,
  describeRequestError,
  isNonTerminal,
  type ProcessResponse,
  type RecordingStatus,
  type RecordingSummary,
} from '../../lib/api';
import { colors, fonts, fontSizes, spacing, radius } from '../../lib/theme';

const MAX_TICKS_PER_ROUND  = 5;
const MIN_TICK_INTERVAL_MS = 2000;
const MAX_TICK_INTERVAL_MS = 8000;
const IDLE_RECHECK_MS      = 5000;

export default function RecordingsScreen() {
  const router = useRouter();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [query,      setQuery]      = useState('');
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didMountRef  = useRef(false);
  const mountedRef   = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const tickPending = useCallback(
    async (rows: RecordingSummary[]): Promise<{ delay: number | null; refresh: boolean }> => {
      const pending = rows.filter((r) => isNonTerminal(r.status)).slice(0, MAX_TICKS_PER_ROUND);
      if (pending.length === 0) return { delay: null, refresh: false };

      const ticks = await Promise.all(
        pending.map(async (row) => {
          try {
            const res = await fetch(apiUrl(`/api/recordings/${row._id}/process`), { method: 'POST' });
            if (!res.ok) return null;
            return (await res.json()) as ProcessResponse;
          } catch { return null; }
        }),
      );

      const updates = new Map<string, ProcessResponse>();
      let nextDelay = MIN_TICK_INTERVAL_MS;
      let refresh   = false;
      for (const tick of ticks) {
        if (!tick) continue;
        updates.set(tick.id, tick);
        if (tick.status === 'ready') refresh = true;
        nextDelay = Math.max(nextDelay, Math.min(tick.retryAfterMs || 0, MAX_TICK_INTERVAL_MS));
      }

      if (updates.size && mountedRef.current) {
        setRecordings((prev) =>
          prev.map((row) => {
            const tick = updates.get(row._id);
            if (!tick || tick.status === row.status) return row;
            return { ...row, status: tick.status, error: tick.error ?? row.error };
          }),
        );
      }
      return { delay: updates.size ? nextDelay : MAX_TICK_INTERVAL_MS, refresh };
    },
    [],
  );

  const fetchRecordings = useCallback(async (q = '') => {
    try {
      const url = q
        ? apiUrl(`/api/recordings?q=${encodeURIComponent(q)}`)
        : apiUrl('/api/recordings');
      const res = await fetch(url);
      if (!res.ok) {
        let detail = '';
        try { const body = (await res.json()) as { error?: string }; detail = body.error ?? ''; } catch {}
        throw new Error(`Could not load recordings (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
      }
      const data = (await res.json()) as RecordingSummary[];
      if (!mountedRef.current) return;
      setRecordings(data);
      setError(null);
    } catch (err) {
      if (mountedRef.current) setError(describeRequestError(err, 'Could not load recordings'));
    } finally {
      if (mountedRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => { void fetchRecordings(); }, [fetchRecordings]);

  const recordingsRef = useRef<RecordingSummary[]>([]);
  recordingsRef.current = recordings;
  const fetchRef  = useRef(fetchRecordings);
  fetchRef.current = fetchRecordings;
  const queryRef  = useRef(query);
  queryRef.current = query;

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const run = async () => {
        if (cancelled) return;
        const { delay, refresh } = await tickPending(recordingsRef.current);
        if (cancelled) return;
        if (refresh) void fetchRef.current(queryRef.current);
        timer = setTimeout(() => { void run(); }, delay ?? IDLE_RECHECK_MS);
      };
      void run();
      return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [tickPending]),
  );

  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void fetchRecordings(query); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, fetchRecordings]);

  function onRefresh() { setRefreshing(true); void fetchRecordings(query); }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.amber} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>moments</Text>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="search your moments…"
          placeholderTextColor={colors.fog}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          autoCapitalize="none"
          autoCorrect={false}
          selectionColor={colors.amber}
        />
      </View>

      {error && (
        <Pressable style={styles.errorRow} onPress={() => void fetchRecordings(query)}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>tap to retry</Text>
        </Pressable>
      )}

      <FlatList
        data={recordings}
        keyExtractor={(item) => item._id}
        renderItem={({ item }) => (
          <RecordingCard
            recording={item}
            onPress={() => router.push(`/recording/${item._id}`)}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.amber}
          />
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>
              {query ? 'no results found' : 'no moments yet'}
            </Text>
            {!query && (
              <Text style={styles.emptyHint}>tap record to capture your first</Text>
            )}
          </View>
        }
        contentContainerStyle={recordings.length === 0 ? styles.emptyContainer : styles.listContent}
      />
    </View>
  );
}

function RecordingCard({ recording, onPress }: { recording: RecordingSummary; onPress: () => void }) {
  const accentColor = STATUS_COLORS[recording.status] ?? colors.mist;
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
    >
      {/* Amber left accent bar */}
      <View style={[styles.cardAccent, { backgroundColor: accentColor }]} />

      <View style={styles.cardBody}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {recording.title}
          </Text>
          <StatusBadge status={recording.status} />
        </View>
        <Text style={styles.cardMeta}>
          {formatDate(recording.createdAt)}
          {recording.duration     ? `  ·  ${formatDuration(recording.duration)}` : ''}
          {recording.location?.placeName ? `  ·  ${recording.location.placeName}` : ''}
        </Text>
        {recording.status === 'failed' && recording.error && (
          <Text style={styles.cardError} numberOfLines={1}>{recording.error}</Text>
        )}
      </View>
    </Pressable>
  );
}

const STATUS_LABELS: Record<RecordingStatus, string> = {
  uploaded:    'queued',
  transcribing:'transcribing',
  enriching:   'enriching',
  ready:       'ready',
  failed:      'failed',
};

const STATUS_COLORS: Record<RecordingStatus, string> = {
  uploaded:    colors.amber,
  transcribing:colors.amber,
  enriching:   colors.amber,
  ready:       colors.success,
  failed:      colors.error,
};

function StatusBadge({ status }: { status: RecordingStatus }) {
  const color = STATUS_COLORS[status] ?? colors.mist;
  return (
    <View style={[styles.badge, { backgroundColor: color + '18' }]}>
      <Text style={[styles.badgeText, { color }]}>{STATUS_LABELS[status] ?? status}</Text>
    </View>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: colors.midnight },
  centered:        { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  emptyContainer:  { flex: 1 },
  listContent:     { paddingBottom: spacing.xl },

  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: fontSizes.xxl,
    color: colors.cream,
    letterSpacing: 1,
  },

  searchRow: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  searchInput: {
    backgroundColor: colors.charcoal,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    fontSize: fontSizes.base,
    fontFamily: fonts.body,
    color: colors.cream,
    borderWidth: 1,
    borderColor: colors.border,
  },

  errorRow: {
    backgroundColor: colors.errorSubtle,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginHorizontal: spacing.md,
    borderRadius: radius.sm,
    marginBottom: spacing.xs,
  },
  errorText: { fontFamily: fonts.body, color: colors.error, fontSize: fontSizes.sm },
  errorHint: { fontFamily: fonts.body, color: colors.mist,  fontSize: fontSizes.xs, marginTop: 2 },

  emptyText: { fontFamily: fonts.body, color: colors.mist,  fontSize: fontSizes.base },
  emptyHint: { fontFamily: fonts.body, color: colors.fog,   fontSize: fontSizes.sm  },

  // Card
  card: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    backgroundColor: colors.obsidian,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  cardPressed: {
    opacity: 0.75,
  },
  cardAccent: {
    width: 3,
    borderTopLeftRadius: radius.md,
    borderBottomLeftRadius: radius.md,
  },
  cardBody: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.xxs,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontFamily: fonts.title,
    fontSize: fontSizes.md,
    color: colors.cream,
    flex: 1,
    marginRight: spacing.xs,
  },
  cardMeta: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.mist,
  },
  cardError: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.error,
  },
  badge: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  badgeText: {
    fontFamily: fonts.bold,
    fontSize: fontSizes.xs,
  },
});
