/**
 * whisper.ts
 *
 * OpenAI-SDK client pointed at the Whisper transcriptions endpoint. Kept
 * separate from llm.ts so the two can point at different providers — e.g.
 * OpenAI directly for Whisper while using OpenRouter for the chat LLM.
 *
 * Configuration (all optional):
 *   WHISPER_API_KEY  — falls back to LLM_API_KEY when absent
 *   WHISPER_BASE_URL — falls back to LLM_BASE_URL when absent
 *   WHISPER_MODEL    — model id; defaults to "whisper-1"
 *
 * The timeout is long because audio transcriptions are synchronous and a large
 * file can take minutes. maxRetries is 0 for the same reason as in llm.ts: the
 * recording pipeline is the retry loop.
 */

import OpenAI from 'openai';

const WHISPER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

let client: OpenAI | null = null;

export function whisperClient(): OpenAI {
  if (client) return client;

  const apiKey =
    process.env.WHISPER_API_KEY?.trim() ||
    process.env.LLM_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      'Missing WHISPER_API_KEY (or LLM_API_KEY) — set one to enable transcription',
    );
  }

  const baseURL =
    process.env.WHISPER_BASE_URL?.trim() ||
    process.env.LLM_BASE_URL?.trim() ||
    undefined;

  client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: WHISPER_TIMEOUT_MS,
    maxRetries: 0,
  });

  return client;
}

export function getWhisperModel(): string {
  return process.env.WHISPER_MODEL?.trim() || 'whisper-1';
}

export function isWhisperConfigured(): boolean {
  return Boolean(
    process.env.WHISPER_API_KEY?.trim() || process.env.LLM_API_KEY?.trim(),
  );
}
