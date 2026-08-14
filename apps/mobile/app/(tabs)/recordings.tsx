/**
 * Tab 2 — My Recordings
 *
 * Scrollable list of recordings, sorted by date desc.
 * Search bar at top triggers hybrid search (debounced 300ms).
 * Tapping a card navigates to the recording detail screen.
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
import { useRouter } from 'expo-router';
import { apiUrl } from '../../lib/api';
import type { Recording } from '@walfly/db';

const RED = '#E53935';
const MUTED = '#888';

export default function RecordingsScreen() {
  const router = useRouter();
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchRecordings = useCallback(async (q = '') => {
    try {
      const url = q
        ? apiUrl(`/api/recordings?q=${encodeURIComponent(q)}`)
        : apiUrl('/api/recordings');
      const res = await fetch(url);
      if (!res.ok) return;
      const data = (await res.json()) as Recording[];
      setRecordings(data);
    } catch (err) {
      console.error('[recordings] fetch failed:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  // Debounced search
  useEffect(() => {
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
      {/* Search bar */}
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
  recording: Recording;
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
    </Pressable>
  );
}

function StatusBadge({ status }: { status: Recording['status'] }) {
  const color =
    status === 'ready' ? '#43A047' : status === 'error' ? RED : '#F9A825';
  const label =
    status === 'ready' ? 'Ready' : status === 'error' ? 'Error' : 'Processing';
  return (
    <View style={[styles.badge, { backgroundColor: color + '22' }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
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
