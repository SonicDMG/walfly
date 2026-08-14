/**
 * ChatScreen — shared component for both global chat (Tab 3)
 * and per-recording chat (launched from Recording Detail).
 *
 * Props:
 *   recordingId? — if provided, chat is scoped to that recording's transcript
 *   title?       — header title override
 */

import React, { useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import * as Progress from 'react-native-progress';
import { useChat, ChatMessage } from '../hooks/useChat';

const RED = '#E53935';
const BLUE = '#3b5bdb';
const MUTED = '#888';

interface Props {
  recordingId?: string;
  title?: string;
}

export default function ChatScreen({ recordingId, title }: Props) {
  const { messages, send, isStreaming, error, reset } = useChat({ recordingId });
  const [input, setInput] = React.useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    await send(text);
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title ?? (recordingId ? 'Recording Chat' : 'Global Chat')}
        </Text>
        {messages.length > 0 && (
          <Pressable onPress={reset} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>Clear</Text>
          </Pressable>
        )}
      </View>

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {recordingId ? '🎙 Ask about this recording' : '🌐 Ask across all recordings'}
          </Text>
          <Text style={styles.emptyHint}>
            {recordingId
              ? 'Ask questions about what was said, who was mentioned, or what decisions were made.'
              : 'Search and ask questions across all your recorded conversations.'}
          </Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => <MessageBubble message={item} />}
          contentContainerStyle={styles.messageList}
        />
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <View style={styles.streamingRow}>
          <Progress.CircleSnail color={[BLUE, MUTED]} size={16} thickness={2} />
          <Text style={styles.streamingText}>Thinking…</Text>
        </View>
      )}

      {/* Error */}
      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask something…"
          placeholderTextColor={MUTED}
          multiline
          maxLength={2000}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="send"
          editable={!isStreaming}
        />
        <Pressable
          style={[styles.sendBtn, (!input.trim() || isStreaming) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || isStreaming}
        >
          <Text style={styles.sendBtnText}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
      <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
        {message.content}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a', flex: 1 },
  clearBtn: { paddingHorizontal: 8 },
  clearBtnText: { color: MUTED, fontSize: 13 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a1a', textAlign: 'center' },
  emptyHint: { fontSize: 14, color: MUTED, textAlign: 'center', lineHeight: 20 },
  messageList: { padding: 16, gap: 10 },
  bubble: { maxWidth: '80%', borderRadius: 16, padding: 12, marginBottom: 6 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: BLUE },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: '#f0f0f0' },
  bubbleText: { fontSize: 15, lineHeight: 21 },
  bubbleTextUser: { color: '#fff' },
  bubbleTextAssistant: { color: '#1a1a1a' },
  streamingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingBottom: 4 },
  streamingText: { fontSize: 12, color: MUTED },
  errorText: { color: RED, fontSize: 13, textAlign: 'center', padding: 8 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    color: '#1a1a1a',
    maxHeight: 100,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: BLUE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#ccc' },
  sendBtnText: { color: '#fff', fontSize: 18, fontWeight: '700', lineHeight: 20 },
});
