/**
 * POST /api/chat
 *
 * Streaming chat over the user's recordings. The server is stateless: the
 * client owns the conversation and sends the whole history on every turn, so
 * there is no conversation id anywhere in this codebase.
 *
 * Retrieval has two modes. With a recordingId the transcript of that one
 * recording is injected, truncated to a fixed character budget. Without one,
 * Astra vector search returns the most relevant recordings and only their
 * titles, summaries and key takeaways are injected — never raw transcripts,
 * which would blow past any proxy's context window.
 *
 * Everything that can fail is resolved BEFORE the stream opens, so a retrieval
 * error is an honest JSON 500 rather than an error event behind a 200.
 */

import { NextRequest, NextResponse } from 'next/server';
import { clampVectorizeText, getRecordingsCollection } from '@walfly/db';
import type { Recording } from '@walfly/db';
import { getLlmModel, llmClient } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  recordingId?: string;
}

const CONTEXT_RECORDINGS = 5;
/** Below this cosine similarity a recording is noise, not context. */
const MIN_SIMILARITY = 0.55;
const CHAT_TRANSCRIPT_MAX_CHARS = 24_000;
/** Newest turns only; the whole history would grow without bound. */
const MAX_HISTORY_MESSAGES = 20;

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return NextResponse.json({ error: '`messages` must be a non-empty array' }, { status: 400 });
  }

  const history: ChatMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') {
      return NextResponse.json({ error: 'Each message needs a string `content`' }, { status: 400 });
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      return NextResponse.json({ error: 'Each message role must be "user" or "assistant"' }, { status: 400 });
    }
    if (message.content.trim()) history.push({ role: message.role, content: message.content });
  }

  const lastUserMessage = [...history].reverse().find((m) => m.role === 'user')?.content.trim();
  if (!lastUserMessage) {
    return NextResponse.json({ error: 'No user message to answer' }, { status: 400 });
  }

  let systemPrompt: string;
  try {
    systemPrompt = await buildSystemPrompt(lastUserMessage, body.recordingId);
  } catch (err) {
    console.error('[Astra] retrieval failed:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load recording context' },
      { status: 500 },
    );
  }

  let client: ReturnType<typeof llmClient>;
  let model: string;
  try {
    client = llmClient();
    model = getLlmModel();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'LLM is not configured' },
      { status: 500 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (payload: unknown) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));

      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.slice(-MAX_HISTORY_MESSAGES),
          ],
          stream: true,
          temperature: 0.7,
        });

        for await (const chunk of completion) {
          const token = chunk.choices[0]?.delta?.content ?? '';
          if (token) send({ token });
        }
      } catch (err) {
        send({ error: err instanceof Error ? err.message : 'LLM request failed' });
      } finally {
        // [DONE] is emitted on both paths so a client that terminates on the
        // sentinel never hangs.
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Stops nginx-style intermediaries buffering the whole stream to the end.
      'X-Accel-Buffering': 'no',
    },
  });
}

/** Builds the grounded system prompt, or a truthful ungrounded one. */
async function buildSystemPrompt(question: string, recordingId?: string): Promise<string> {
  const collection = getRecordingsCollection();

  if (recordingId) {
    console.log(`[Astra] fetching recording ${recordingId} for single-recording context`);
    const rec = await collection.findOne({ _id: recordingId });
    if (!rec) {
      console.log(`[Astra] recording ${recordingId} not found`);
      return 'You are the assistant for the Walfly app. The recording the user is asking about no longer exists; say so plainly.';
    }
    console.log(`[Astra] building transcript context for "${rec.title}" (${(rec.transcript ?? '').length} chars)`);

    const transcript = (rec.transcript ?? '').slice(0, CHAT_TRANSCRIPT_MAX_CHARS);
    const truncated = (rec.transcript ?? '').length > CHAT_TRANSCRIPT_MAX_CHARS;

    if (!transcript.trim()) {
      return [
        'You are the assistant for the Walfly app.',
        `The recording "${rec.title}" has no transcript yet (status: ${rec.status}).`,
        'Tell the user it is still being processed, or failed, and do not invent its contents.',
      ].join(' ');
    }

    return [
      "You are a helpful assistant with access to the user's recorded conversations.",
      'Answer only from the transcript below. If it does not contain the answer, say so.',
      '',
      `Recording: "${rec.title}" (${formatDate(rec.createdAt)})`,
      '',
      transcript,
      truncated ? '\n[transcript truncated]' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const clampedQuery = clampVectorizeText(question);
  console.log(`[Astra / Vectorize] vector search — query=${clampedQuery.length} chars limit=${CONTEXT_RECORDINGS} minSimilarity=${MIN_SIMILARITY}`);
  const results = await collection
    .find(
      { status: 'ready' },
      {
        // Clamped: the embedding provider hard-caps input at 512 tokens and
        // rejects the whole find() when a longer query is sent.
        sort: { $vectorize: clampedQuery },
        limit: CONTEXT_RECORDINGS,
        includeSimilarity: true,
        projection: { title: 1, createdAt: 1, summary: 1, keyTakeaways: 1 },
      },
    )
    .toArray();

  const relevant = (results as unknown as Array<Recording & { $similarity?: number }>).filter(
    (r) => (r.$similarity ?? 0) >= MIN_SIMILARITY,
  );

  console.log(`[Astra / Vectorize] returned ${results.length} candidates, ${relevant.length} above similarity threshold`);
  if (relevant.length > 0) {
    for (const r of relevant) {
      console.log(`[Astra / Vectorize]   "${(r as Recording).title}" similarity=${((r as Recording & { $similarity?: number }).$similarity ?? 0).toFixed(3)}`);
    }
  }

  if (relevant.length === 0) {
    return 'You are the assistant for the Walfly app. None of the user\'s recordings are relevant to this question. Say so, and answer generally only if that is useful.';
  }

  const context = relevant
    .map((r) => {
      const takeaways = Array.isArray(r.keyTakeaways) ? r.keyTakeaways : [];
      return [
        `Recording: "${r.title}" (${formatDate(r.createdAt)})`,
        r.summary ? `Summary: ${r.summary}` : null,
        takeaways.length ? `Key takeaways:\n${takeaways.map((t) => `- ${t}`).join('\n')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n---\n\n');

  return [
    "You are a helpful assistant with access to summaries of the user's recorded conversations.",
    'Answer from the context below. It contains summaries, not full transcripts, so say when a detail is not available.',
    '',
    'Context:',
    context,
  ].join('\n');
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown date' : date.toISOString().slice(0, 10);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}
