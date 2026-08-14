/**
 * useChat.ts
 *
 * Manages streaming chat state. Works on web (native EventSource)
 * and on native via fetch + manual stream reading.
 *
 * Usage:
 *   const { messages, send, isStreaming } = useChat({ recordingId });
 */

import { useState, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { apiUrl } from '../lib/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function useChat(opts: { recordingId?: string } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef<string | undefined>(undefined);

  const send = useCallback(
    async (userMessage: string) => {
      if (!userMessage.trim() || isStreaming) return;
      setError(null);

      // Append user message immediately
      setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);

      // Placeholder assistant message that we'll stream into
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
      setIsStreaming(true);

      try {
        await (Platform.OS === 'web' ? streamWeb : streamNative)(userMessage);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat error');
        // Replace placeholder with error text
        setMessages((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: '(Error — please try again)' };
          return copy;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, opts.recordingId],
  );

  async function streamWeb(userMessage: string) {
    // Web: use fetch + ReadableStream reader
    const res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: userMessage,
        conversationId: conversationIdRef.current,
        recordingId: opts.recordingId,
      }),
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const parsed = JSON.parse(raw) as { token?: string; conversationId?: string; error?: string };
          if (parsed.conversationId) conversationIdRef.current = parsed.conversationId;
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.token) {
            setMessages((prev) => {
              const copy = [...prev];
              copy[copy.length - 1] = {
                role: 'assistant',
                content: (copy[copy.length - 1].content ?? '') + parsed.token,
              };
              return copy;
            });
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  }

  // Native uses same fetch/ReadableStream path — React Native 0.73+ supports it
  const streamNative = streamWeb;

  function reset() {
    setMessages([]);
    setError(null);
    conversationIdRef.current = undefined;
  }

  return { messages, send, isStreaming, error, reset };
}
