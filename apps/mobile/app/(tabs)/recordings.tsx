/**
 * Tab 2 — My Recordings
 *
 * Scrollable list of recordings, sorted by date desc, with a debounced search
 * box. Failures are shown inline: a silently swallowed non-ok response is what
 * made broken search look like "search returns everything".
 *
 * This screen is also the pipeline's self-healing mechanism. Nothing advances a
 * recording on the server by itself, and one job needs many ticks — one to
 * submit, one per Docling poll, one to enrich — so while the screen is focused
 * it keeps ticking every non-terminal row on a timer honouring the server's own
 * retryAfterMs, and stops the moment every row is terminal. The number of rows
 * ticked at once is capped so a large backlog cannot fan out.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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

const RED = '#E53935';
const MUTED = '#888';

/** Upper bound on recordings advanced concurrently by one tick round. */
const MAX_TICKS_PER_ROUND = 5;
/** Floor and ceiling for the self-heal timer; the server's retryAfterMs sits between them. */
const MIN_TICK_INTERVAL_MS = 2000;
const MAX_TICK_INTERVAL_MS = 8000;
/** How often the focused screen re-checks for work when nothing is pending. */
const IDLE_RECHECK_MS = 5000;

export default function RecordingsScreen() {
  const router = useRouter();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didMountRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Advances every non-terminal row by one step and folds the reported status
   * back into the list. Reports the delay before the next round, and whether a
   * job just finished — a finished job has a real title and summary the list
   * only learns about by re-fetching.
   */
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
        } catch {
          return null;
        }
      }),
    );

    const updates = new Map<string, ProcessResponse>();
    let nextDelay = MIN_TICK_INTERVAL_MS;
    let refresh = false;
    for (const tick of ticks) {
      if (!tick) continue;
      updates.set(tick.id, tick);
      if (tick.status === 'ready') refresh = true;
      // Reuse the server's own backoff, exactly as drivePipeline does.
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

    // A round that got no usable answer still has work outstanding; back off to
    // the ceiling rather than hammering a failing server.
    return { delay: updates.size ? nextDelay : MAX_TICK_INTERVAL_MS, refresh };
    },
    [],
  );

  const fetchRecordings = useCallback(
    async (q = '') => {
      try {
        const url = q
          ? apiUrl(`/api/recordings?q=${encodeURIComponent(q)}`)
          : apiUrl('/api/recordings');
        const res = await fetch(url);

        if (!res.ok) {
          let detail = '';
          try {
            const body = (await res.json()) as { error?: string };
            detail = body.error ?? '';
          } catch {
            // Non-JSON error body.
          }
          throw new Error(`Could not load recordings (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
        }

        const data = (await res.json()) as RecordingSummary[];
        if (!mountedRef.current) return;
        setRecordings(data);
        setError(null);
      } catch (err) {
        console.error('[recordings] fetch failed:', err);
        if (mountedRef.current) setError(describeRequestError(err, 'Could not load recordings'));
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  // Initial load.
  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  // Read from the focus loop so it never has to restart on every render.
  const recordingsRef = useRef<RecordingSummary[]>([]);
  recordingsRef.current = recordings;
  const fetchRef = useRef(fetchRecordings);
  fetchRef.current = fetchRecordings;
  const queryRef = useRef(query);
  queryRef.current = query;

  /**
   * While this screen is focused, keep advancing non-terminal recordings. A job
   * needs one tick per pipeline step, so a single tick per pull-to-refresh is
   * not self-healing in any useful sense. When every row is terminal the loop
   * issues no requests at all and just idles; it is torn down entirely when the
   * screen loses focus.
   */
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const run = async () => {
        if (cancelled) return;
        const { delay, refresh } = await tickPending(recordingsRef.current);
        if (cancelled) return;
        // A job that just reached "ready" has a real title and summary now.
        if (refresh) void fetchRef.current(queryRef.current);
        timer = setTimeout(() => {
          void run();
        }, delay ?? IDLE_RECHECK_MS);
      };

      void run();

      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    }, [tickPending]),
  );

  // Debounced search. Skipped on the first run so mount does not fetch twice.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchRecordings(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, fetchRecordings]);

  function onRefresh() {
    setRefreshing(true);
    void fetchRecordings(query);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={RED} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search recordings…"
          placeholderTextColor={MUTED}
          value={query}
          onChangeText={setQuery}
          clearButtonMode="while-editing"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {error && (
        <Pressable style={styles.errorRow} onPress={() => void fetchRecordings(query)}>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorHint}>Tap to retry</Text>
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={RED} />
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>
              {query ? 'No results found.' : 'No recordings yet.'}
            </Text>
          </View>
        }
        contentContainerStyle={recordings.length === 0 ? styles.emptyContainer : undefined}
      />
    </View>
  );
}

function RecordingCard({
  recording,
  onPress,
}: {
  recording: RecordingSummary;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress} accessibilityRole="button">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {recording.title}
        </Text>
        <StatusBadge status={recording.status} />
      </View>
      <Text style={styles.cardMeta}>
        {formatDate(recording.createdAt)}
        {recording.duration ? `  ·  ${formatDuration(recording.duration)}` : ''}
        {recording.location?.placeName ? `  ·  ${recording.location.placeName}` : ''}
      </Text>
      {recording.status === 'failed' && recording.error ? (
        <Text style={styles.cardError} numberOfLines={2}>
          {recording.error}
        </Text>
      ) : null}
    </Pressable>
  );
}

const STATUS_LABELS: Record<RecordingStatus, string> = {
  uploaded: 'Queued',
  transcribing: 'Transcribing',
  enriching: 'Summarising',
  ready: 'Ready',
  failed: 'Failed',
};

const STATUS_COLORS: Record<RecordingStatus, string> = {
  uploaded: '#F9A825',
  transcribing: '#F9A825',
  enriching: '#F9A825',
  ready: '#43A047',
  failed: RED,
};

function StatusBadge({ status }: { status: RecordingStatus }) {
  const color = STATUS_COLORS[status] ?? MUTED;
  return (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      <Text style={[styles.badgeText, { color }]}>{STATUS_LABELS[status] ?? status}</Text>
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyContainer: { flex: 1 },
  emptyText: { color: MUTED, fontSize: 15 },
  searchRow: {
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  searchInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: '#1a1a1a',
  },
  errorRow: {
    backgroundColor: RED + '11',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorText: { color: RED, fontSize: 13 },
  errorHint: { color: MUTED, fontSize: 11, marginTop: 2 },
  card: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1a1a1a',
    flex: 1,
    marginRight: 8,
  },
  cardMeta: {
    fontSize: 12,
    color: MUTED,
  },
  cardError: {
    fontSize: 12,
    color: RED,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
