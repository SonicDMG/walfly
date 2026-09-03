/**
 * ChatScreen — shared component for global chat (Tab 3)
 * and per-recording chat (launched from Recording Detail).
 *
 * Dark-first. Amber accents. Walfly design system.
 */

import { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useChat, ChatMessage } from '../hooks/useChat';
import { colors, fonts, fontSizes, spacing, radius } from '../lib/theme';

interface Props {
  recordingId?: string;
  title?: string;
}

export default function ChatScreen({ recordingId, title }: Props) {
  const { messages, send, isStreaming, error, reset } = useChat({ recordingId });
  const [input, setInput] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

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

  const scopeLabel = recordingId ? 'this recording' : 'all moments';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>
            {title ?? 'chat'}
          </Text>
          <View style={styles.scopeChip}>
            <Text style={styles.scopeChipText}>{scopeLabel}</Text>
          </View>
        </View>
        {messages.length > 0 && (
          <Pressable onPress={reset} style={styles.clearBtn}>
            <Text style={styles.clearBtnText}>clear</Text>
          </Pressable>
        )}
      </View>

      {/* Empty state */}
      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>
            {recordingId ? 'ask about this recording' : 'ask across your moments'}
          </Text>
          <Text style={styles.emptyHint}>
            {recordingId
              ? 'What was decided? Who was mentioned? What are the action items?'
              : 'Search and explore across all your recorded conversations.'}
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
          <View style={styles.streamingDot} />
          <Text style={styles.streamingText}>thinking…</Text>
        </View>
      )}

      {error && <Text style={styles.errorText}>{error}</Text>}

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="ask something…"
          placeholderTextColor={colors.fog}
          multiline
          maxLength={2000}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="send"
          editable={!isStreaming}
          selectionColor={colors.amber}
        />
        <Pressable
          style={[styles.sendBtn, (!input.trim() || isStreaming) && styles.sendBtnDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || isStreaming}
          accessibilityRole="button"
          accessibilityLabel="Send message"
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
        <View style={styles.bubbleUser}>
          <Text style={styles.bubbleTextUser}>{message.content}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.rowAssistant}>
      <View style={styles.bubbleAssistant}>
        {isStreaming ? (
          <Text style={styles.bubbleTextAssistant}>{message.content}</Text>
        ) : (
          <Markdown style={markdownStyles}>{message.content}</Markdown>
        )}
      </View>
    </View>
  );
}

const markdownStyles = {
  body:      { fontSize: fontSizes.base, lineHeight: 22, color: colors.cream, margin: 0, fontFamily: fonts.body },
  paragraph: { marginTop: 0, marginBottom: 6 },
  code_inline: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: colors.charcoal,
    borderRadius: 3,
    paddingHorizontal: 4,
    fontSize: fontSizes.sm,
    color: colors.amber,
  },
  fence: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: colors.charcoal,
    borderRadius: radius.sm,
    padding: spacing.sm,
    fontSize: fontSizes.sm,
    lineHeight: 20,
    marginVertical: 4,
    color: colors.cream,
  },
  bullet_list:  { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item:    { marginBottom: 3 },
  heading1: { fontSize: fontSizes.md, fontWeight: '700' as const, marginBottom: 4, marginTop: 8, color: colors.cream, fontFamily: fonts.display },
  heading2: { fontSize: fontSizes.base, fontWeight: '700' as const, marginBottom: 4, marginTop: 6, color: colors.cream },
  heading3: { fontSize: fontSizes.base, fontWeight: '600' as const, marginBottom: 2, marginTop: 4, color: colors.cream },
  strong: { fontWeight: '600' as const, color: colors.cream },
  hr: { backgroundColor: colors.border, height: 1, marginVertical: 8 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, marginVertical: 6, overflow: 'hidden' as const },
  thead: { backgroundColor: colors.charcoal },
  th: { padding: 6, fontWeight: '600' as const, fontSize: fontSizes.sm, borderRightWidth: 1, borderRightColor: colors.border, color: colors.cream },
  td: { padding: 6, fontSize: fontSizes.sm, borderRightWidth: 1, borderRightColor: colors.border, color: colors.mist },
  tr: { borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row' as const },
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.midnight },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flex: 1,
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: fontSizes.xxl,
    color: colors.cream,
    letterSpacing: 1,
  },
  scopeChip: {
    backgroundColor: colors.amberSubtle,
    borderRadius: radius.full,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.amberGlow,
  },
  scopeChipText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.amber,
  },
  clearBtn: { paddingHorizontal: spacing.xs },
  clearBtnText: { fontFamily: fonts.body, color: colors.mist, fontSize: fontSizes.sm },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyTitle: {
    fontFamily: fonts.title,
    fontSize: fontSizes.lg,
    color: colors.cream,
    textAlign: 'center',
  },
  emptyHint: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.mist,
    textAlign: 'center',
    lineHeight: 22,
  },

  messageList: { padding: spacing.md, gap: spacing.xs },

  rowUser:      { width: '100%', alignItems: 'flex-end',   marginBottom: spacing.xs },
  rowAssistant: { width: '100%', alignItems: 'flex-start', marginBottom: spacing.xs },

  bubbleUser: {
    maxWidth: '80%',
    borderRadius: radius.lg,
    borderBottomRightRadius: radius.sm,
    backgroundColor: colors.amberDim,
    padding: spacing.sm,
  },
  bubbleTextUser: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    lineHeight: 21,
  },
  bubbleAssistant: {
    backgroundColor: colors.charcoal,
    borderRadius: radius.lg,
    borderBottomLeftRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    maxWidth: '88%',
  },
  bubbleTextAssistant: {
    fontFamily: fonts.body,
    fontSize: fontSizes.base,
    color: colors.cream,
    lineHeight: 21,
  },

  streamingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxs,
  },
  streamingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  streamingText: {
    fontFamily: fonts.body,
    fontSize: fontSizes.xs,
    color: colors.mist,
  },

  errorText: {
    fontFamily: fonts.body,
    color: colors.error,
    fontSize: fontSizes.sm,
    textAlign: 'center',
    padding: spacing.xs,
  },

  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  input: {
    flex: 1,
    backgroundColor: colors.charcoal,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    fontSize: fontSizes.base,
    fontFamily: fonts.body,
    color: colors.cream,
    maxHeight: 100,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.charcoal, borderWidth: 1, borderColor: colors.border },
  sendBtnText: {
    color: colors.midnight,
    fontSize: fontSizes.lg,
    fontFamily: fonts.bold,
    lineHeight: 22,
  },
});
