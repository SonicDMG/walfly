/**
 * useChat.ts
 *
 * Streaming chat against POST /api/chat. The server is stateless: this hook
 * owns the conversation and sends the full message history on every turn, so
 * there is no conversation id anywhere in the codebase.
 *
 * React Native's global fetch is an XHR-backed polyfill with no
 * `response.body`, so native uses `expo/fetch`, which does implement streaming
 * response bodies. If a runtime still hands back a body-less response, the
 * whole SSE payload is read with text() and parsed in one pass rather than
 * failing a request that actually succeeded.
 */

import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { apiUrl, describeRequestError } from '../lib/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface StreamEvent {
  token?: string;
  error?: string;
}

/** Minimal shape shared by the DOM Response and expo/fetch's FetchResponse. */
interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?(): void;
}

interface ByteStream {
  getReader(): ByteReader;
}

export function useChat(opts: { recordingId?: string } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);

  const commit = useCallback((next: ChatMessage[]) => {
    historyRef.current = next;
    setMessages(next);
  }, []);

  const send = useCallback(
    async (userMessage: string) => {
      const text = userMessage.trim();
      if (!text || isStreaming) return;

      setError(null);
      const base: ChatMessage[] = [...historyRef.current, { role: 'user', content: text }];
      commit([...base, { role: 'assistant', content: '' }]);
      setIsStreaming(true);

      let assistant = '';
      const append = (chunk: string) => {
        assistant += chunk;
        commit([...base, { role: 'assistant', content: assistant }]);
      };

      try {
        const res = await postChat(base, opts.recordingId);

        if (!res.ok) {
          throw new Error(`Chat failed (HTTP ${res.status}): ${await safeText(res)}`);
        }

        const stream = res.body as ByteStream | null | undefined;
        if (stream && typeof stream.getReader === 'function') {
          await consumeStream(stream, append);
        } else {
          // No streaming body available — parse the complete SSE payload at once.
          consumeSseBuffer(await res.text(), append);
        }

        if (!assistant) {
          throw new Error('The assistant returned an empty response.');
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : describeRequestError(err, 'Chat failed');
        setError(message);
        commit([...base, { role: 'assistant', content: assistant || message }]);
      } finally {
        setIsStreaming(false);
      }
    },
    [commit, isStreaming, opts.recordingId],
  );

  const reset = useCallback(() => {
    historyRef.current = [];
    setMessages([]);
    setError(null);
  }, []);

  return { messages, send, isStreaming, error, reset };
}

/** Uses expo/fetch on native so `response.body` is a real ReadableStream. */
async function postChat(
  history: ChatMessage[],
  recordingId: string | undefined,
): Promise<Response> {
  const doFetch = (Platform.OS === 'web' ? fetch : expoFetch) as typeof fetch;
  try {
    return await doFetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, recordingId }),
    });
  } catch (err) {
    throw new Error(describeRequestError(err, 'Chat failed'));
  }
}

async function consumeStream(stream: ByteStream, append: (chunk: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (handleSseLine(line, append)) return;
      }
    }
    if (buffer) handleSseLine(buffer, append);
  } finally {
    reader.releaseLock?.();
  }
}

function consumeSseBuffer(payload: string, append: (chunk: string) => void): void {
  for (const line of payload.split('\n')) {
    if (handleSseLine(line, append)) return;
  }
}

/** Returns true when the stream is finished. Throws on a server-reported error. */
function handleSseLine(line: string, append: (chunk: string) => void): boolean {
  if (!line.startsWith('data: ')) return false;

  const raw = line.slice(6).trim();
  if (raw === '[DONE]') return true;
  if (!raw) return false;

  let parsed: StreamEvent;
  try {
    parsed = JSON.parse(raw) as StreamEvent;
  } catch {
    return false;
  }

  if (parsed.error) throw new Error(parsed.error);
  if (parsed.token) append(parsed.token);
  return false;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
