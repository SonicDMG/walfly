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
import Markdown from 'react-native-markdown-display';
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
          renderItem={({ item, index }) => (
            <MessageBubble
              message={item}
              isStreaming={isStreaming && index === messages.length - 1 && item.role === 'assistant'}
            />
          )}
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

function MessageBubble({ message, isStreaming }: { message: ChatMessage; isStreaming?: boolean }) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <View style={styles.rowUser}>
        <View style={[styles.bubble, styles.bubbleUser]}>
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{message.content}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.rowAssistant}>
      <View style={styles.bubbleAssistant}>
        {isStreaming ? (
          <Text style={[styles.bubbleText, styles.bubbleTextAssistant]}>{message.content}</Text>
        ) : (
          <Markdown style={markdownStyles}>{message.content}</Markdown>
        )}
      </View>
    </View>
  );
}

const markdownStyles = {
  body: { fontSize: 15, lineHeight: 22, color: '#1a1a1a', margin: 0 },
  paragraph: { marginTop: 0, marginBottom: 6 },
  code_inline: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: '#ddd',
    borderRadius: 3,
    paddingHorizontal: 4,
    fontSize: 13,
  },
  fence: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: '#e0e0e0',
    borderRadius: 6,
    padding: 10,
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 4,
  },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginBottom: 3 },
  heading1: { fontSize: 17, fontWeight: '700' as const, marginBottom: 4, marginTop: 8 },
  heading2: { fontSize: 16, fontWeight: '700' as const, marginBottom: 4, marginTop: 6 },
  heading3: { fontSize: 15, fontWeight: '600' as const, marginBottom: 2, marginTop: 4 },
  strong: { fontWeight: '600' as const },
  hr: { backgroundColor: '#ccc', height: 1, marginVertical: 8 },
  // Tables
  table: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, marginVertical: 6, overflow: 'hidden' as const },
  thead: { backgroundColor: '#e0e0e0' },
  th: { padding: 6, fontWeight: '600' as const, fontSize: 13, borderRightWidth: 1, borderRightColor: '#ccc' },
  td: { padding: 6, fontSize: 13, borderRightWidth: 1, borderRightColor: '#ccc' },
  tr: { borderBottomWidth: 1, borderBottomColor: '#ccc', flexDirection: 'row' as const },
};

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
  messageList: { padding: 16, gap: 8 },
  rowUser: { width: '100%', alignItems: 'flex-end' },
  rowAssistant: { width: '100%', alignItems: 'flex-start' },
  bubble: { maxWidth: '80%', borderRadius: 16, padding: 12 },
  bubbleUser: { backgroundColor: BLUE },
  bubbleAssistant: { backgroundColor: '#f0f0f0', borderRadius: 16, padding: 12, maxWidth: '88%' },
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
