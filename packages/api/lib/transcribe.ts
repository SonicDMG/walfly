/**
 * transcribe.ts
 *
 * Sends an audio file URL to the Docling SaaS API and returns the SRT transcript.
 * Diarization is post-MVP — transcript is returned as plain text for now.
 *
 * Docling SaaS API reference:
 *   POST https://api.docling.cloud/v1/transcribe
 *   Headers: Authorization: Bearer <DOCLING_API_KEY>
 *   Body: { "url": "<audio_url>" }
 *   Response: { "status": "completed" | "processing", "transcript": { "srt": "..." } }
 *
 * We poll until status === "completed" or a timeout is hit.
 */

const DOCLING_API_BASE = 'https://api.docling.cloud/v1';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max

export interface TranscribeResult {
  srt: string;
}

export async function transcribeAudio(audioUrl: string): Promise<TranscribeResult> {
  const apiKey = process.env.DOCLING_API_KEY;
  if (!apiKey) throw new Error('Missing DOCLING_API_KEY env var');

  // Submit transcription job
  const submitRes = await fetch(`${DOCLING_API_BASE}/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url: audioUrl }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`Docling transcription submit failed: ${submitRes.status} ${body}`);
  }

  const { job_id } = (await submitRes.json()) as { job_id: string };

  // Poll for completion
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await fetch(`${DOCLING_API_BASE}/transcribe/${job_id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`Docling poll failed: ${pollRes.status} ${body}`);
    }

    const data = (await pollRes.json()) as {
      status: 'processing' | 'completed' | 'failed';
      transcript?: { srt?: string; text?: string };
      error?: string;
    };

    if (data.status === 'failed') {
      throw new Error(`Docling transcription failed: ${data.error ?? 'unknown error'}`);
    }

    if (data.status === 'completed') {
      const srt = data.transcript?.srt ?? data.transcript?.text ?? '';
      return { srt };
    }
    // status === 'processing' → continue polling
  }

  throw new Error('Docling transcription timed out after 10 minutes');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
