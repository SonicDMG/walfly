/**
 * llm.ts
 *
 * Thin OpenAI-SDK wrapper pointed at an OpenAI-compatible LLM proxy.
 * Swap models/providers by changing env vars — no code changes needed:
 *   LLM_BASE_URL  — proxy base URL (e.g. https://openrouter.ai/api/v1)
 *   LLM_API_KEY   — API key for the proxy
 *   LLM_MODEL     — model identifier (e.g. gpt-4o, claude-3-5-sonnet, etc.)
 */

import OpenAI from 'openai';

function getLlmClient(): OpenAI {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY env var');
  }

  return new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

/** Default model from env, falls back to gpt-4o */
export function getLlmModel(): string {
  return process.env.LLM_MODEL ?? 'gpt-4o';
}

/** Singleton LLM client (lazy) */
let _client: OpenAI | null = null;
export function llmClient(): OpenAI {
  if (!_client) _client = getLlmClient();
  return _client;
}
