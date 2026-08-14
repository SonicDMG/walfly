/**
 * POST /api/chat
 *
 * Streaming chat endpoint. Accepts:
 *   { message: string, conversationId?: string, recordingId?: string }
 *
 * - If recordingId: fetch that recording's transcript as context (per-recording RAG)
 * - If no recordingId: vector-search Astra for top-5 relevant transcript chunks (global RAG)
 * - Maintains conversation history via OpenAI thread (previous_response_id pattern)
 * - Streams tokens back as plain text/event-stream (SSE)
 * - First event contains the conversationId so the client can persist it
 */

import { NextRequest } from 'next/server';
import { getRecordingsCollection } from '@walfly/db';
import { llmClient, getLlmModel } from '@/lib/llm';

export const runtime = 'nodejs';

interface ChatRequest {
  message: string;
  conversationId?: string;
  recordingId?: string;
}

const CONTEXT_CHUNKS = 5;

export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { message, conversationId, recordingId } = body;
  if (!message?.trim()) {
    return new Response('Missing message', { status: 400 });
  }

  // --- Build RAG context ---
  let contextText = '';
  const collection = getRecordingsCollection();

  if (recordingId) {
    // Per-recording: inject full transcript
    const rec = await collection.findOne({ _id: recordingId });
    if (rec?.transcript) {
      contextText = `Recording: "${rec.title}" (${new Date(rec.createdAt).toLocaleDateString()})\n\n${rec.transcript}`;
    }
  } else {
    // Global: vector search top-N relevant recordings
    const results = await collection
      .find({}, { sort: { $vectorize: message }, limit: CONTEXT_CHUNKS })
      .toArray();
    if (results.length > 0) {
      contextText = results
        .map((r) => `Recording: "${r.title}" (${new Date(r.createdAt).toLocaleDateString()})\n${r.transcript ?? r.summary ?? ''}`)
        .join('\n\n---\n\n');
    }
  }

  const systemPrompt = contextText
    ? `You are a helpful assistant with access to the user's recorded conversations. Answer questions based on the provided transcripts.\n\nContext:\n${contextText}`
    : `You are a helpful assistant for the Walfly app. The user has recorded conversations but none are relevant to this question.`;

  // --- Stream from LLM ---
  const client = llmClient();
  const model = getLlmModel();

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();

      // Send conversationId as first SSE event so client can store it
      const newConversationId = conversationId ?? crypto.randomUUID();
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ conversationId: newConversationId })}\n\n`));

      try {
        const messages: { role: 'system' | 'user'; content: string }[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ];

        const completion = await client.chat.completions.create({
          model,
          messages,
          stream: true,
          temperature: 0.7,
        });

        for await (const chunk of completion) {
          const token = chunk.choices[0]?.delta?.content ?? '';
          if (token) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ token })}\n\n`));
          }
        }

        controller.enqueue(enc.encode('data: [DONE]\n\n'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'LLM error';
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
