/**
 * enrich.ts
 *
 * Calls the LLM proxy (OpenAI Responses API, non-streaming) to extract:
 *   - summary
 *   - keyTakeaways
 *   - actionItems
 *   - suggested title
 *
 * Uses structured output (JSON mode) for reliable parsing.
 */

import { llmClient, getLlmModel } from './llm';

export interface EnrichResult {
  title: string;
  summary: string;
  keyTakeaways: string[];
  actionItems: string[];
}

const SYSTEM_PROMPT = `You are an expert meeting analyst. Given a conversation transcript, extract the following as JSON:
- title: a concise, descriptive title for the conversation (max 8 words)
- summary: a 2-4 sentence summary of what was discussed
- keyTakeaways: an array of 3-7 key insights or conclusions from the conversation
- actionItems: an array of specific action items mentioned or implied (empty array if none)

Respond only with valid JSON matching this exact structure:
{
  "title": "string",
  "summary": "string",
  "keyTakeaways": ["string"],
  "actionItems": ["string"]
}`;

export async function enrichTranscript(transcript: string): Promise<EnrichResult> {
  const client = llmClient();
  const model = getLlmModel();

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Transcript:\n\n${transcript}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error('LLM returned empty response during enrichment');

  let parsed: EnrichResult;
  try {
    parsed = JSON.parse(raw) as EnrichResult;
  } catch {
    throw new Error(`LLM enrichment returned invalid JSON: ${raw}`);
  }

  return {
    title: parsed.title ?? 'Untitled Recording',
    summary: parsed.summary ?? '',
    keyTakeaways: Array.isArray(parsed.keyTakeaways) ? parsed.keyTakeaways : [],
    actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
  };
}
