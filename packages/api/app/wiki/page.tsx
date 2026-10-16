'use client';

/**
 * /wiki — Live Walfly Codebase Q&A
 *
 * A developer tool: ask any question about the Walfly codebase and get a
 * streaming answer grounded in the current state of the GitHub repo.
 *
 * No build step, no database, no stale docs. GitHub is the source of truth.
 * Answers include [filename:line] citations that link directly to GitHub.
 *
 * Intentionally plain — this is a dev tool, not a product UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// Extend Window to carry the highlight.js global injected via CDN script.
declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: HTMLElement) => void;
      configure: (opts: Record<string, unknown>) => void;
    };
  }
}

const REPO_URL = 'https://github.com/SonicDMG/walfly';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WikiPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Hi! Ask me anything about the Walfly codebase. I read the current source directly from GitHub, so my answers always reflect the latest code.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Inject highlight.js + GitHub Dark theme from CDN once on mount.
  useEffect(() => {
    if (document.getElementById('hljs-css')) return;

    const link = document.createElement('link');
    link.id = 'hljs-css';
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github-dark.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js';
    script.onload = () => window.hljs?.configure({ ignoreUnescapedHTML: true });
    document.head.appendChild(script);
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput('');
    setLoading(true);

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: question };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', pending: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    // Build history for the API (exclude the pending assistant placeholder)
    const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch('/api/wiki/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${err.error ?? 'Unknown error'}`, pending: false }
              : m,
          ),
        );
        return;
      }

      // Stream SSE tokens
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE events from the buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data) as { token?: string; error?: string };
            if (parsed.error) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + `\n\nError: ${parsed.error}`, pending: false }
                    : m,
                ),
              );
            } else if (parsed.token) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + parsed.token } : m,
                ),
              );
            }
          } catch {
            // partial JSON line — skip
          }
        }
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Network error: ${err instanceof Error ? err.message : String(err)}`, pending: false }
            : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, pending: false } : m)),
      );
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div>
            <span style={styles.title}>Walfly Wiki</span>
            <span style={styles.subtitle}> — live codebase Q&A</span>
          </div>
          <a href={REPO_URL} target="_blank" rel="noreferrer" style={styles.repoLink}>
            SonicDMG/walfly ↗
          </a>
        </div>
      </header>

      {/* Message list */}
      <main style={styles.main}>
        <div style={styles.messageList}>
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </main>

      {/* Input area */}
      <footer style={styles.footer}>
        <div style={styles.inputRow}>
          <textarea
            ref={inputRef}
            style={styles.textarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about any part of the codebase… (Enter to send, Shift+Enter for newline)"
            rows={2}
            disabled={loading}
            autoFocus
          />
          <button onClick={() => void send()} disabled={loading || !input.trim()} style={styles.sendBtn}>
            {loading ? '…' : '→'}
          </button>
        </div>
        <p style={styles.hint}>Answers are grounded in the current GitHub source. Always verify citations.</p>
      </footer>
    </div>
  );
}

// ── MessageBubble ─────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAssistant) }}>
      <div style={styles.bubbleRole}>{isUser ? 'You' : 'Wiki'}</div>
      {message.pending && !message.content ? (
        <span style={styles.pending}>thinking…</span>
      ) : (
        <FormattedContent content={message.content} />
      )}
    </div>
  );
}

// ── FormattedContent ──────────────────────────────────────────────────────────
// Renders Markdown-like content: code blocks, inline code, bold, and GitHub
// citation links. Kept intentionally simple — no external markdown library.

function FormattedContent({ content }: { content: string }) {
  const parts = parseContent(content);
  return (
    <div style={styles.content}>
      {parts.map((part, i) => {
        if (part.type === 'code-block') {
          return <HighlightedBlock key={i} text={part.text} lang={part.lang} />;
        }
        if (part.type === 'paragraph') {
          return (
            <p key={i} style={styles.paragraph}>
              {renderInline(part.text)}
            </p>
          );
        }
        return null;
      })}
    </div>
  );
}

type ContentPart = { type: 'code-block'; text: string; lang: string } | { type: 'paragraph'; text: string };

// ── HighlightedBlock ──────────────────────────────────────────────────────────
// Renders a syntax-highlighted code block using highlight.js (loaded from CDN).
// Falls back gracefully to plain text if hljs hasn't loaded yet.

function HighlightedBlock({ text, lang }: { text: string; lang: string }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (ref.current && window.hljs) {
      window.hljs.highlightElement(ref.current);
    }
  });

  return (
    <pre style={styles.codeBlock}>
      <code ref={ref} className={lang ? `language-${lang}` : undefined}>
        {text}
      </code>
    </pre>
  );
}

function parseContent(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  // Capture optional language hint after the opening fence (e.g. ```typescript)
  const codeBlockRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const prose = content.slice(lastIndex, match.index).trim();
      if (prose) parts.push({ type: 'paragraph', text: prose });
    }
    parts.push({ type: 'code-block', lang: match[1].toLowerCase(), text: match[2].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  const remaining = content.slice(lastIndex).trim();
  if (remaining) parts.push({ type: 'paragraph', text: remaining });

  return parts;
}

// Renders inline markdown: **bold**, `code`, and [label](url) links.
function renderInline(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*.*?\*\*|`[^`]+`|\[.*?\]\(.*?\))/g);
  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={i}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return <code key={i} style={styles.inlineCode}>{token.slice(1, -1)}</code>;
    }
    const linkMatch = token.match(/^\[(.*?)\]\((.*?)\)$/);
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noreferrer" style={styles.link}>
          {linkMatch[1]}
        </a>
      );
    }
    // Preserve newlines as line breaks
    return token.split('\n').flatMap((line, j, arr) =>
      j < arr.length - 1 ? [line, <br key={`${i}-${j}`} />] : [line],
    );
  });
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100dvh',
    fontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    fontSize: '14px',
    lineHeight: 1.6,
    color: '#1f2328',
    background: '#ffffff',
  },
  header: {
    borderBottom: '1px solid #e5e7eb',
    padding: '12px 20px',
    flexShrink: 0,
  },
  headerInner: {
    maxWidth: '760px',
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontWeight: 600,
    fontSize: '15px',
  },
  subtitle: {
    color: '#57606a',
    fontSize: '13px',
  },
  repoLink: {
    color: '#3b82d4',
    textDecoration: 'none',
    fontSize: '12px',
  },
  main: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '20px',
  },
  messageList: {
    maxWidth: '760px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  },
  bubble: {
    borderRadius: '8px',
    padding: '12px 16px',
    maxWidth: '100%',
  },
  bubbleUser: {
    background: '#f7f8fa',
    border: '1px solid #e5e7eb',
    alignSelf: 'flex-end' as const,
    maxWidth: '80%',
  },
  bubbleAssistant: {
    background: '#ffffff',
    border: '1px solid #e5e7eb',
    alignSelf: 'flex-start' as const,
    width: '100%',
  },
  bubbleRole: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#57606a',
    marginBottom: '6px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  pending: {
    color: '#57606a',
    fontStyle: 'italic' as const,
  },
  content: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  paragraph: {
    margin: 0,
  },
  codeBlock: {
    background: '#f7f8fa',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    padding: '12px',
    overflowX: 'auto' as const,
    fontSize: '13px',
    lineHeight: 1.5,
    margin: 0,
  },
  inlineCode: {
    background: '#f7f8fa',
    border: '1px solid #e5e7eb',
    borderRadius: '3px',
    padding: '1px 5px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
  },
  link: {
    color: '#3b82d4',
    textDecoration: 'none',
  },
  footer: {
    borderTop: '1px solid #e5e7eb',
    padding: '12px 20px',
    flexShrink: 0,
  },
  inputRow: {
    maxWidth: '760px',
    margin: '0 auto',
    display: 'flex',
    gap: '8px',
  },
  textarea: {
    flex: 1,
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    fontSize: '14px',
    lineHeight: 1.5,
    fontFamily: 'inherit',
    resize: 'none' as const,
    outline: 'none',
  },
  sendBtn: {
    padding: '0 18px',
    background: '#1f2328',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '18px',
    cursor: 'pointer',
    flexShrink: 0,
    opacity: 1,
  },
  hint: {
    maxWidth: '760px',
    margin: '6px auto 0',
    fontSize: '11px',
    color: '#57606a',
  },
} as const;
