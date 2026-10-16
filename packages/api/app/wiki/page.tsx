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

const REPO_URL  = 'https://github.com/SonicDMG/walfly';
const REPO_BASE = 'https://github.com/SonicDMG/walfly/blob/main';

// ── Walfly design tokens (mirrors apps/mobile/lib/theme.ts) ───────────────
const c = {
  midnight:    '#0D0D0F',
  obsidian:    '#141416',
  charcoal:    '#1E1E22',
  border:      '#2A2A2F',
  amber:       '#F5A623',
  amberDim:    '#C4801A',
  amberGlow:   '#F5A62326',
  amberSubtle: '#F5A62312',
  cream:       '#F5EDD6',
  mist:        '#9B9AA3',
  fog:         '#55545D',
} as const;

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
  const [sidebarWidth, setSidebarWidth] = useState(380); // px
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Drag-to-resize divider ────────────────────────────────────────────────
  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const containerW = containerRef.current.offsetWidth;
      const delta = dragStartX.current - ev.clientX; // dragging left = bigger sidebar
      const next = Math.min(
        Math.max(dragStartWidth.current + delta, 240), // min 240 px
        containerW - 320,                               // max: leave 320 px for chat
      );
      setSidebarWidth(next);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Inject highlight.js + tokyo-night-dark theme from CDN once on mount.
  useEffect(() => {
    // Always set the correct href in case a previous session loaded a different theme.
    let link = document.getElementById('hljs-css') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = 'hljs-css';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/tokyo-night-dark.min.css';

    if (!document.getElementById('hljs-script')) {
      const script = document.createElement('script');
      script.id = 'hljs-script';
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js';
      script.onload = () => window.hljs?.configure({ ignoreUnescapedHTML: true });
      document.head.appendChild(script);
    }
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
      <div ref={containerRef} style={styles.body}>

        {/* Left: chat pane — fills remaining space */}
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

        {/* Drag handle */}
        <div
          style={styles.divider}
          onMouseDown={onDividerMouseDown}
          title="Drag to resize"
        />

        {/* Right: sidebar — fixed pixel width, user-resizable */}
        <aside style={{ ...styles.sidebar, width: sidebarWidth, flexShrink: 0 }}>
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
//
// Renders the prose ProsePart[] line-by-line so headings, horizontal rules,
// and list items are handled in addition to plain paragraphs.

interface ProseContentProps {
  prose: ProsePart[];
  activeRef: number | null;
  onCitationClick: (idx: number) => void;
}

function ProseContent({ prose, activeRef, onCitationClick }: ProseContentProps) {
  // Re-assemble the prose parts into a single string so we can split on lines,
  // but preserve citation markers as a special sentinel we can re-expand.
  // We encode citations as \x00REF:<index>\x00 to survive line splitting.

  let flat = '';
  for (const part of prose) {
    if (part.type === 'citation') {
      flat += `\x00REF:${part.refIndex}:${encodeURIComponent(part.label)}:${encodeURIComponent(part.url)}\x00`;
    } else {
      flat += part.value;
    }
  }

  const nodes: React.ReactNode[] = [];
  let key = 0;

  // Split into logical blocks (blank-line separated).
  const blocks = flat.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    const firstLine = lines[0].trim();

    // Horizontal rule
    if (/^---+$/.test(firstLine) && lines.length === 1) {
      nodes.push(<hr key={key++} style={styles.hr} />);
      continue;
    }

    // Heading
    const headingMatch = firstLine.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch && lines.length === 1) {
      const level = headingMatch[1].length;
      const headingStyle = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      nodes.push(
        <div key={key++} style={headingStyle}>
          {renderInlineWithCitations(headingMatch[2], key * 100, activeRef, onCitationClick)}
        </div>,
      );
      key++;
      continue;
    }

    // Ordered list: lines starting with "N." or "N)"
    if (lines.every((l) => /^\s*\d+[.)]\s/.test(l))) {
      nodes.push(
        <ol key={key++} style={styles.ol}>
          {lines.map((l, i) => {
            const text = l.replace(/^\s*\d+[.)]\s+/, '');
            return (
              <li key={i} style={styles.li}>
                {renderInlineWithCitations(text, key * 100 + i, activeRef, onCitationClick)}
              </li>
            );
          })}
        </ol>,
      );
      key++;
      continue;
    }

    // Unordered list: lines starting with "- " or "* "
    if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
      nodes.push(
        <ul key={key++} style={styles.ul}>
          {lines.map((l, i) => {
            const text = l.replace(/^\s*[-*]\s+/, '');
            return (
              <li key={i} style={styles.li}>
                {renderInlineWithCitations(text, key * 100 + i, activeRef, onCitationClick)}
              </li>
            );
          })}
        </ul>,
      );
      key++;
      continue;
    }

    // Default: paragraph (join lines with spaces)
    const paraText = lines.join(' ');
    nodes.push(
      <p key={key++} style={styles.paragraph}>
        {renderInlineWithCitations(paraText, key * 100, activeRef, onCitationClick)}
      </p>,
    );
    key++;
  }

  return <div style={styles.content}>{nodes}</div>;
}

// ── PlainContent — older messages (no interactive citations needed) ─────────

function PlainContent({ content }: { content: string }) {
  const textOnly = content.replace(/```[\s\S]*?```/g, '').trim();
  const nodes: React.ReactNode[] = [];
  let key = 0;

  const blocks = textOnly.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const firstLine = lines[0].trim();

    if (/^---+$/.test(firstLine) && lines.length === 1) {
      nodes.push(<hr key={key++} style={styles.hr} />);
      continue;
    }
    const headingMatch = firstLine.match(/^(#{1,3})\s+(.*)/);
    if (headingMatch && lines.length === 1) {
      const level = headingMatch[1].length;
      const headingStyle = level === 1 ? styles.h1 : level === 2 ? styles.h2 : styles.h3;
      nodes.push(<div key={key++} style={headingStyle}>{renderInline(headingMatch[2], key * 100)}</div>);
      key++;
      continue;
    }
    if (lines.every((l) => /^\s*\d+[.)]\s/.test(l))) {
      nodes.push(
        <ol key={key++} style={styles.ol}>
          {lines.map((l, i) => <li key={i} style={styles.li}>{renderInline(l.replace(/^\s*\d+[.)]\s+/, ''), key * 100 + i)}</li>)}
        </ol>,
      );
      key++;
      continue;
    }
    if (lines.every((l) => /^\s*[-*]\s/.test(l))) {
      nodes.push(
        <ul key={key++} style={styles.ul}>
          {lines.map((l, i) => <li key={i} style={styles.li}>{renderInline(l.replace(/^\s*[-*]\s+/, ''), key * 100 + i)}</li>)}
        </ul>,
      );
      key++;
      continue;
    }
    nodes.push(<p key={key++} style={styles.paragraph}>{renderInline(lines.join(' '), key * 100)}</p>);
    key++;
  }

  return <div style={styles.content}>{nodes}</div>;
}

// ── renderInlineWithCitations ──────────────────────────────────────────────
// Like renderInline but also expands \x00REF:...\x00 sentinels back into
// clickable citation spans.

function renderInlineWithCitations(
  text: string,
  baseKey: number,
  activeRef: number | null,
  onCitationClick: (idx: number) => void,
): React.ReactNode[] {
  const sentinelRe = /\x00REF:(\d+):([^\x00]*):([^\x00]*)\x00/g;
  const parts = text.split(sentinelRe);
  const nodes: React.ReactNode[] = [];

  // split with a 3-group regex produces: [text, idx, label, url, text, idx, label, url, ...]
  let i = 0;
  let k = baseKey;
  while (i < parts.length) {
    const segment = parts[i];
    if (segment) {
      nodes.push(...renderInline(segment, k));
      k += 100;
    }
    i++;
    if (i + 2 < parts.length) {
      const refIndex = parseInt(parts[i], 10);
      const label = decodeURIComponent(parts[i + 1]);
      i += 3; // skip idx, label, url
      const isActive = activeRef === refIndex;
      nodes.push(
        <span
          key={k++}
          style={{ ...styles.citationSpan, ...(isActive ? styles.citationActive : {}) }}
          onClick={() => onCitationClick(refIndex)}
          title={`View ${label} in sidebar`}
        >
          {label}
        </span>,
      );
    }
  }
  return nodes;
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

function parseMessage(rawContent: string): ParsedMessage {
  const refs: RefBlock[] = [];
  const prose: ProsePart[] = [];

  // If the LLM wrapped its entire response in a single outer fence, unwrap it.
  const outerFenceMatch = rawContent.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n?```\s*$/);
  const content = outerFenceMatch ? outerFenceMatch[1] : rawContent;

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
        // Normal case: citation immediately before this code block.
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
        // No preceding citation — check if the most recent ref in the prose
        // has empty text (citation emitted after code block rather than before).
        const lastRef = refs.length > 0 ? refs[refs.length - 1] : null;
        if (lastRef && lastRef.text === '') {
          lastRef.lang = lang;
          lastRef.text = text;
        }
        // If still no home for this code block, keep it inline rather than
        // creating a sidebar card with a broken repo-homepage URL.
      }
    }
  }

  // Remaining text after the last match.
  const tail = content.slice(lastIndex);
  if (tail.trim()) prose.push({ type: 'text', value: tail });

  return { prose, refs };
}

// ── Inline renderer ────────────────────────────────────────────────────────
// Handles **bold**, *italic*, `inline code`, and [label](url) plain links.

function renderInline(text: string, baseKey: number): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((token, i) => {
    const k = baseKey + i;
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={k}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('*') && token.endsWith('*') && !token.startsWith('**')) {
      return <em key={k}>{token.slice(1, -1)}</em>;
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

// ── Styles — Walfly dark theme ─────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100dvh',
    fontFamily: 'Inter, -apple-system, system-ui, sans-serif',
    fontSize: '14px',
    lineHeight: 1.6,
    color: c.cream,
    background: c.midnight,
  },

  // ── Header ──
  header: {
    borderBottom: `1px solid ${c.border}`,
    padding: '10px 20px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  // "walfly" wordmark — mirrors fonts.display (Playfair Display 700)
  title: {
    fontFamily: 'Georgia, "Times New Roman", serif',
    fontWeight: 700,
    fontSize: '16px',
    color: c.cream,
    letterSpacing: '1px',
  },
  subtitle: { color: c.mist, fontSize: '13px', flex: 1 },
  repoLink: { color: c.amber, textDecoration: 'none', fontSize: '12px' },

  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },

  // ── Chat pane ──
  chatPane: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px 20px',
    minWidth: 0,
  },
  messageList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  },

  // Drag handle
  divider: {
    width: '4px',
    flexShrink: 0,
    cursor: 'col-resize',
    background: c.border,
    transition: 'background 0.15s',
  },

  // ── Bubbles ──
  bubble: {
    borderRadius: '12px',
    padding: '12px 16px',
  },
  bubbleUser: {
    background: c.amberSubtle,
    border: `1px solid ${c.amberGlow}`,
    alignSelf: 'flex-end' as const,
    maxWidth: '85%',
    borderBottomRightRadius: '4px',
  },
  bubbleAssistant: {
    background: c.charcoal,
    border: `1px solid ${c.border}`,
    width: '100%',
    borderBottomLeftRadius: '4px',
  },
  bubbleRole: {
    fontSize: '10px',
    fontWeight: 600,
    color: c.mist,
    marginBottom: '6px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  pending: { color: c.mist, fontStyle: 'italic' as const },
  content: { display: 'flex', flexDirection: 'column' as const, gap: '8px' },
  paragraph: { margin: 0, color: c.cream },

  // Markdown block elements
  h1: { fontFamily: 'Georgia, serif', fontSize: '18px', fontWeight: 700, color: c.cream, margin: '4px 0 2px', letterSpacing: '0.3px' },
  h2: { fontFamily: 'Georgia, serif', fontSize: '16px', fontWeight: 700, color: c.cream, margin: '4px 0 2px' },
  h3: { fontFamily: 'inherit', fontSize: '14px', fontWeight: 600, color: c.amber, margin: '4px 0 2px' },
  hr: { border: 'none', borderTop: `1px solid ${c.border}`, margin: '8px 0' },
  ul: { margin: '0', paddingLeft: '20px', color: c.cream },
  ol: { margin: '0', paddingLeft: '20px', color: c.cream },
  li: { marginBottom: '3px' },

  // Citation pill spans — amber on dark
  citationSpan: {
    display: 'inline-block',
    padding: '1px 7px',
    borderRadius: '4px',
    background: c.amberSubtle,
    border: `1px solid ${c.amberGlow}`,
    color: c.amber,
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    cursor: 'pointer',
    userSelect: 'none' as const,
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'middle' as const,
    margin: '0 2px',
  },
  citationActive: {
    background: `${c.amber}28`,
    border: `1px solid ${c.amber}`,
    color: c.amber,
  },

  inlineCode: {
    background: c.obsidian,
    border: `1px solid ${c.border}`,
    borderRadius: '3px',
    padding: '1px 5px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    color: c.amber,
  },
  link: { color: c.amber, textDecoration: 'none' },

  // ── Sidebar ──
  sidebar: {
    overflowY: 'auto' as const,
    background: c.obsidian,
    borderLeft: `1px solid ${c.border}`,
  },
  sidebarEmpty: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '32px',
  },
  sidebarEmptyText: {
    color: c.fog,
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
    fontSize: '10px',
    fontWeight: 600,
    color: c.mist,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
  },

  // ── Ref cards ──
  refCard: {
    borderRadius: '8px',
    border: `1px solid ${c.border}`,
    background: c.charcoal,
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  },
  refCardActive: {
    border: `2px solid ${c.amber}`,
    boxShadow: `0 0 0 3px ${c.amberGlow}`,
  },
  refCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '7px 12px',
    borderBottom: `1px solid ${c.border}`,
    background: c.obsidian,
  },
  refCardFilename: {
    fontSize: '12px',
    fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
    color: c.cream,
    fontWeight: 500,
  },
  refCardLink: {
    fontSize: '11px',
    color: c.amber,
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
    // Keep our dark surface — hljs injects a stylesheet background on <pre>
    // but inline style wins over class-based rules.
    background: '#1E1E22',
    borderRadius: '0 0 8px 8px', // matches refCard bottom radius
  },

  // ── Footer / input ──
  footer: {
    borderTop: `1px solid ${c.border}`,
    padding: '12px 20px',
    flexShrink: 0,
    background: c.midnight,
  },
  inputRow: {
    display: 'flex',
    gap: '8px',
  },
  textarea: {
    flex: 1,
    padding: '10px 14px',
    border: `1px solid ${c.border}`,
    borderRadius: '20px',
    fontSize: '14px',
    lineHeight: 1.5,
    fontFamily: 'inherit',
    resize: 'none' as const,
    outline: 'none',
    background: c.charcoal,
    color: c.cream,
  },
  sendBtn: {
    width: '38px',
    height: '38px',
    borderRadius: '50%',
    background: c.amber,
    color: c.midnight,
    border: 'none',
    fontSize: '18px',
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: {
    margin: '6px 0 0',
    fontSize: '11px',
    color: c.fog,
  },
} as const;
