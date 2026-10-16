'use client';

/**
 * /wiki — Live Walfly Codebase Q&A
 *
 * Two-column layout:
 *   Left  — prose answers, citations are clickable spans
 *   Right — code reference sidebar; clicking a citation highlights the card
 *
 * No external dependencies. highlight.js + github-dark loaded from CDN.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// ── Window extension for highlight.js CDN global ───────────────────────────
declare global {
  interface Window {
    hljs?: {
      highlightElement: (el: HTMLElement) => void;
      configure: (opts: Record<string, unknown>) => void;
    };
  }
}

const REPO_URL = 'https://github.com/SonicDMG/walfly';
const REPO_BASE = 'https://github.com/SonicDMG/walfly/blob/main';

// ── Types ──────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

/** A code block extracted from the LLM response, to be shown in the sidebar. */
interface RefBlock {
  index: number;   // stable id within a message, 0-based
  lang: string;
  text: string;
  label: string;   // e.g. "llm.ts:24" — from the citation that introduced it
  url: string;     // github link
}

/** Parsed representation of a single assistant message. */
interface ParsedMessage {
  /** Prose segments interleaved with citation markers {refIndex}. */
  prose: ProsePart[];
  refs: RefBlock[];
}

type ProsePart =
  | { type: 'text'; value: string }
  | { type: 'citation'; refIndex: number; label: string; url: string };

// ── Main component ─────────────────────────────────────────────────────────

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
  const [activeRef, setActiveRef] = useState<number | null>(null);
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

  // Auto-scroll chat to bottom on new messages.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Reset active ref when a new assistant message starts streaming.
  const latestAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput('');
    setLoading(true);
    setActiveRef(null);

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content: question };
    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: 'assistant', content: '', pending: true };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

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
              ? { ...m, content: `Error: ${(err as { error?: string }).error ?? 'Unknown error'}`, pending: false }
              : m,
          ),
        );
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
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
          } catch { /* partial line */ }
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

  // Parse the latest assistant message for the sidebar.
  const parsedLatest = latestAssistantMsg
    ? parseMessage(latestAssistantMsg.content)
    : null;

  return (
    <div style={styles.root}>
      {/* ── Header ── */}
      <header style={styles.header}>
        <span style={styles.title}>Walfly Wiki</span>
        <span style={styles.subtitle}> — live codebase Q&A</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer" style={styles.repoLink}>
          SonicDMG/walfly ↗
        </a>
      </header>

      {/* ── Body: chat + sidebar ── */}
      <div style={styles.body}>

        {/* Left: chat pane */}
        <div style={styles.chatPane}>
          <div style={styles.messageList}>
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isLatestAssistant={msg.id === latestAssistantMsg?.id}
                parsedLatest={parsedLatest}
                activeRef={activeRef}
                onCitationClick={(idx) => setActiveRef(idx)}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Right: sidebar */}
        <aside style={styles.sidebar}>
          <Sidebar
            refs={parsedLatest?.refs ?? []}
            activeRef={activeRef}
            onRefClick={(idx) => setActiveRef(idx)}
          />
        </aside>
      </div>

      {/* ── Input ── */}
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
          <button
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            style={styles.sendBtn}
          >
            {loading ? '…' : '→'}
          </button>
        </div>
        <p style={styles.hint}>
          Grounded in the current GitHub source — citations open in GitHub.
        </p>
      </footer>
    </div>
  );
}

// ── MessageBubble ──────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message;
  isLatestAssistant: boolean;
  parsedLatest: ParsedMessage | null;
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function MessageBubble({
  message,
  isLatestAssistant,
  parsedLatest,
  activeRef,
  onCitationClick,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  return (
    <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAssistant) }}>
      <div style={styles.bubbleRole}>{isUser ? 'You' : 'Wiki'}</div>
      {message.pending && !message.content ? (
        <span style={styles.pending}>thinking…</span>
      ) : isLatestAssistant && parsedLatest ? (
        <ProseContent
          prose={parsedLatest.prose}
          activeRef={activeRef}
          onCitationClick={onCitationClick}
        />
      ) : (
        <PlainContent content={message.content} />
      )}
    </div>
  );
}

// ── ProseContent — latest assistant message with interactive citations ─────

interface ProseContentProps {
  prose: ProsePart[];
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function ProseContent({ prose, activeRef, onCitationClick }: ProseContentProps) {
  // Group consecutive text parts into paragraphs, citations inline.
  const nodes: React.ReactNode[] = [];
  let paragraphTokens: React.ReactNode[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraphTokens.length > 0) {
      nodes.push(<p key={key++} style={styles.paragraph}>{paragraphTokens}</p>);
      paragraphTokens = [];
    }
  };

  for (const part of prose) {
    if (part.type === 'citation') {
      const isActive = activeRef === part.refIndex;
      paragraphTokens.push(
        <span
          key={key++}
          style={{ ...styles.citationSpan, ...(isActive ? styles.citationActive : {}) }}
          onClick={() => onCitationClick(part.refIndex)}
          title={`View ${part.label} in sidebar`}
        >
          {part.label}
        </span>,
      );
    } else {
      // Render inline markdown within the text segment
      const inlineNodes = renderInline(part.value, key);
      key += inlineNodes.length + 1;

      // Split on double newlines → paragraph boundaries
      const segments = part.value.split(/\n\n+/);
      if (segments.length <= 1) {
        paragraphTokens.push(...renderInline(part.value, key));
        key += 50;
      } else {
        // First segment appends to current paragraph
        paragraphTokens.push(...renderInline(segments[0], key));
        key += 50;
        flushParagraph();
        // Middle segments are their own paragraphs
        for (let i = 1; i < segments.length - 1; i++) {
          nodes.push(
            <p key={key++} style={styles.paragraph}>
              {renderInline(segments[i], key)}
            </p>,
          );
          key += 50;
        }
        // Last segment starts a new paragraph buffer
        paragraphTokens.push(...renderInline(segments[segments.length - 1], key));
        key += 50;
      }
    }
  }
  flushParagraph();

  return <div style={styles.content}>{nodes}</div>;
}

// ── PlainContent — older messages (no interactive citations needed) ─────────

function PlainContent({ content }: { content: string }) {
  // Strip code blocks and render prose only (same as ProseContent but static)
  const textOnly = content.replace(/```[\s\S]*?```/g, '').trim();
  return (
    <div style={styles.content}>
      {textOnly.split(/\n\n+/).map((para, i) => (
        <p key={i} style={styles.paragraph}>
          {renderInline(para, i * 100)}
        </p>
      ))}
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────

interface SidebarProps {
  refs: RefBlock[];
  activeRef: number | null;
  onRefClick: (idx: number) => void;
}

function Sidebar({ refs, activeRef, onRefClick }: SidebarProps) {
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll active card into view when activeRef changes.
  useEffect(() => {
    if (activeRef === null) return;
    const el = cardRefs.current.get(activeRef);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeRef]);

  if (refs.length === 0) {
    return (
      <div style={styles.sidebarEmpty}>
        <p style={styles.sidebarEmptyText}>
          Code references from the current answer will appear here.
          <br /><br />
          Click any citation in the answer to jump to it.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.sidebarContent}>
      <div style={styles.sidebarHeading}>References</div>
      {refs.map((ref) => (
        <RefCard
          key={ref.index}
          ref_={ref}
          isActive={activeRef === ref.index}
          onClick={() => onRefClick(ref.index)}
          cardRef={(el) => {
            if (el) cardRefs.current.set(ref.index, el);
            else cardRefs.current.delete(ref.index);
          }}
        />
      ))}
    </div>
  );
}

// ── RefCard ────────────────────────────────────────────────────────────────

interface RefCardProps {
  ref_: RefBlock;
  isActive: boolean;
  onClick: () => void;
  cardRef: (el: HTMLDivElement | null) => void;
}

function RefCard({ ref_, isActive, onClick, cardRef }: RefCardProps) {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current && window.hljs) {
      window.hljs.highlightElement(codeRef.current);
    }
  });

  // Filename from label: strip line number suffix
  const filename = ref_.label.replace(/:\d+$/, '');

  return (
    <div
      ref={cardRef}
      style={{ ...styles.refCard, ...(isActive ? styles.refCardActive : {}) }}
      onClick={onClick}
    >
      <div style={styles.refCardHeader}>
        <span style={styles.refCardFilename}>{filename}</span>
        <a
          href={ref_.url}
          target="_blank"
          rel="noreferrer"
          style={styles.refCardLink}
          onClick={(e) => e.stopPropagation()}
        >
          GitHub ↗
        </a>
      </div>
      <pre style={styles.refCodeBlock}>
        <code
          ref={codeRef}
          className={ref_.lang ? `language-${ref_.lang}` : undefined}
        >
          {ref_.text}
        </code>
      </pre>
    </div>
  );
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// Parses an LLM response into:
//   prose  — text segments + citation markers (no code blocks)
//   refs   — ordered list of RefBlocks extracted from code fences
//
// The LLM emits citations as [label](url) and code blocks as ```lang\n...\n```.
// We associate each code block with the citation that immediately precedes it
// (or follows it within the same paragraph). If there is no adjacent citation,
// the code block gets a generic label derived from the fence language.

function parseMessage(content: string): ParsedMessage {
  const refs: RefBlock[] = [];
  const prose: ProsePart[] = [];

  // Regex that matches either a citation link or a fenced code block.
  const tokenRe = /(\[([^\]]+)\]\((https?:\/\/[^)]+)\))|(`{3}([a-zA-Z0-9_+-]*)\n?([\s\S]*?)`{3})/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Track the most recent citation seen, to associate with the next code block.
  let pendingCitation: { label: string; url: string } | null = null;

  while ((match = tokenRe.exec(content)) !== null) {
    // Push any text before this match as a prose text part.
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text.trim()) prose.push({ type: 'text', value: text });
    }
    lastIndex = match.index + match[0].length;

    const isCitation = Boolean(match[1]);
    const isCodeBlock = Boolean(match[4]);

    if (isCitation) {
      const label = match[2];
      const url = match[3];
      // Check if this citation is a file:line reference (GitHub link).
      const isFileRef = url.includes('github.com') && /[:#]L?\d+/.test(url);

      if (isFileRef) {
        // Reserve a slot in refs; the code block that follows will fill the text.
        const refIndex = refs.length;
        refs.push({ index: refIndex, lang: '', text: '', label, url });
        prose.push({ type: 'citation', refIndex, label, url });
        pendingCitation = { label, url };
      } else {
        // Non-file link — render as plain inline link.
        prose.push({ type: 'text', value: `[${label}](${url})` });
      }
    } else if (isCodeBlock) {
      const lang = (match[5] ?? '').toLowerCase();
      const text = (match[6] ?? '').trimEnd();

      if (pendingCitation) {
        // Associate with the most recent citation.
        const existing = refs.find((r) => r.label === pendingCitation!.label && r.text === '');
        if (existing) {
          existing.lang = lang;
          existing.text = text;
        } else {
          const refIndex = refs.length;
          refs.push({ index: refIndex, lang, text, label: pendingCitation.label, url: pendingCitation.url });
          prose.push({ type: 'citation', refIndex, label: pendingCitation.label, url: pendingCitation.url });
        }
        pendingCitation = null;
      } else {
        // Standalone code block with no citation — add as a ref with generic label.
        const refIndex = refs.length;
        const label = lang || 'code';
        refs.push({ index: refIndex, lang, text, label, url: REPO_URL });
        prose.push({ type: 'citation', refIndex, label, url: REPO_URL });
      }
    }
  }

  // Remaining text after the last match.
  const tail = content.slice(lastIndex);
  if (tail.trim()) prose.push({ type: 'text', value: tail });

  return { prose, refs };
}

// ── Inline renderer ────────────────────────────────────────────────────────
// Handles **bold**, `inline code`, and [label](url) as plain links.
// Citations are handled upstream by ProseContent, so links here are
// non-GitHub links only (the parser already extracted GitHub refs).

function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, i) => {
    const k = baseKey + i;
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={k}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      return <code key={k} style={styles.inlineCode}>{token.slice(1, -1)}</code>;
    }
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={k} href={linkMatch[2]} target="_blank" rel="noreferrer" style={styles.link}>
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={k}>{token}</span>;
  });
}

// ── Styles ─────────────────────────────────────────────────────────────────

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
    padding: '10px 20px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  title: { fontWeight: 600, fontSize: '15px' },
  subtitle: { color: '#57606a', fontSize: '13px', flex: 1 },
  repoLink: { color: '#3b82d4', textDecoration: 'none', fontSize: '12px' },

  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },

  // ── Chat pane ──
  chatPane: {
    flex: '0 0 60%',
    overflowY: 'auto' as const,
    padding: '20px',
    borderRight: '1px solid #e5e7eb',
  },
  messageList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
    maxWidth: '640px',
    margin: '0 auto',
  },
  bubble: {
    borderRadius: '8px',
    padding: '12px 16px',
  },
  bubbleUser: {
    background: '#f7f8fa',
    border: '1px solid #e5e7eb',
    alignSelf: 'flex-end' as const,
    maxWidth: '85%',
  },
  bubbleAssistant: {
    background: '#ffffff',
    border: '1px solid #e5e7eb',
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
  pending: { color: '#57606a', fontStyle: 'italic' as const },
  content: { display: 'flex', flexDirection: 'column' as const, gap: '6px' },
  paragraph: { margin: 0 },

  // Citation spans — look like pill tags, not links
  citationSpan: {
    display: 'inline-block',
    padding: '1px 7px',
    borderRadius: '4px',
    background: '#eef2ff',
    border: '1px solid #c7d2fe',
    color: '#3730a3',
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'middle' as const,
    margin: '0 2px',
  },
  citationActive: {
    background: '#fef3c7',
    border: '1px solid #f59e0b',
    color: '#92400e',
  },

  inlineCode: {
    background: '#f7f8fa',
    border: '1px solid #e5e7eb',
    borderRadius: '3px',
    padding: '1px 5px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
  },
  link: { color: '#3b82d4', textDecoration: 'none' },

  // ── Sidebar ──
  sidebar: {
    flex: '0 0 40%',
    overflowY: 'auto' as const,
    background: '#f7f8fa',
  },
  sidebarEmpty: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px',
  },
  sidebarEmptyText: {
    color: '#57606a',
    fontSize: '13px',
    textAlign: 'center' as const,
    lineHeight: 1.7,
    margin: 0,
  },
  sidebarContent: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  sidebarHeading: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#57606a',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },

  // ── Ref cards ──
  refCard: {
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    background: '#ffffff',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  refCardActive: {
    border: '2px solid #f59e0b',
    boxShadow: '0 0 0 3px rgba(245,158,11,0.15)',
  },
  refCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid #e5e7eb',
    background: '#f7f8fa',
  },
  refCardFilename: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    color: '#1f2328',
    fontWeight: 500,
  },
  refCardLink: {
    fontSize: '11px',
    color: '#3b82d4',
    textDecoration: 'none',
  },
  refCodeBlock: {
    margin: 0,
    padding: '12px',
    fontSize: '12px',
    lineHeight: 1.5,
    overflowX: 'auto' as const,
    maxHeight: '320px',
    overflowY: 'auto' as const,
  },

  // ── Footer / input ──
  footer: {
    borderTop: '1px solid #e5e7eb',
    padding: '12px 20px',
    flexShrink: 0,
  },
  inputRow: {
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
  },
  hint: {
    margin: '6px 0 0',
    fontSize: '11px',
    color: '#57606a',
  },
} as const;
