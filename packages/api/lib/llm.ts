/**
 * llm.ts
 *
 * Thin OpenAI-SDK wrapper pointed at an OpenAI-compatible proxy (LiteLLM,
 * OpenRouter, Ollama). Provider and model are swapped purely through env:
 *   LLM_BASE_URL  — proxy base URL
 *   LLM_API_KEY   — API key for the proxy ("ollama" for a local Ollama)
 *   LLM_MODEL     — model identifier; REQUIRED, there is no default
 *   LLM_JSON_MODE — auto | on | off; "off" disables response_format entirely
 *
 * The client carries explicit timeouts and NO SDK-level retries: the SDK
 * default is a ten-minute request timeout with two retries, which can hold a
 * serverless invocation open for half an hour. The recording pipeline is itself
 * a retry loop with an expiring lease, so a second retry layer here would only
 * push one call past the lease that guards it and let two paid completions run
 * against the same transcript at once. Worst case is now a single 60 s call.
 */

import OpenAI from 'openai';

let client: OpenAI | null = null;

/** Singleton LLM client. Throws when LLM_API_KEY is missing. */
export function llmClient(): OpenAI {
  if (client) return client;

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('Missing LLM_API_KEY env var — set LLM_API_KEY (use "ollama" for a local Ollama)');
  }

  const baseURL = process.env.LLM_BASE_URL;

  client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: 60_000,
    maxRetries: 0,
  });

  return client;
}

/**
 * The configured model. Deliberately has no default: a silently wrong default
 * model produces a 404 from the proxy that reads like a network failure.
 */
export function getLlmModel(): string {
  const model = process.env.LLM_MODEL;
  if (!model) {
    throw new Error('Missing LLM_MODEL env var — set the exact model id your LLM_BASE_URL serves');
  }
  return model;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);
}

/**
 * A short human-readable label for the configured LLM provider, derived from
 * LLM_BASE_URL. Used in log prefixes so it is immediately obvious which service
 * is being called — e.g. "[LLM:OpenAI]", "[LLM:Ollama]", "[LLM:OpenRouter]".
 */
export function getLlmProvider(): string {
  const base = process.env.LLM_BASE_URL?.trim() ?? '';
  if (!base) return 'OpenAI';
  if (/ollama/i.test(base) || base.includes('11434')) return 'Ollama';
  if (/openrouter/i.test(base)) return 'OpenRouter';
  if (/litellm/i.test(base)) return 'LiteLLM';
  if (/openai/i.test(base)) return 'OpenAI';
  // Fall back to the hostname so the log is still informative for custom proxies.
  try { return new URL(base).hostname; } catch { return base.slice(0, 40); }
}

/** Whether to attempt response_format: json_object. Several proxies reject it. */
export function supportsJsonMode(): boolean {
  return process.env.LLM_JSON_MODE !== 'off';
}
