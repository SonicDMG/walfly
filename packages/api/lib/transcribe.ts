/**
 * transcribe.ts
 *
 * Converts audio to text via Docling.
 *
 * Mode is controlled by DOCLING_MODE env var:
 *   local (default) — runs packages/api/scripts/transcribe.py directly via
 *                     `uv run` using the video_to_openrag project's venv
 *                     (which has docling[asr] + whisper-turbo installed).
 *                     No separate server needed.
 *   saas            — IBM Docling for watsonx REST API at DOCLING_SERVICE_URL.
 *                     Requires DOCLING_API_KEY.
 *
 * Local mode invokes the Python script as a subprocess and captures stdout
 * as the markdown transcript — the same approach used by the reference
 * implementation at github.com/SonicDMG/video_to_openrag.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

// Path to the video_to_openrag project that has docling[asr] installed
const UV_PROJECT = process.env.DOCLING_UV_PROJECT ?? '/tmp/video_to_openrag';
// Path to our transcription script
const SCRIPT_PATH = join(__dirname, '../scripts/transcribe.py');

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface TranscribeResult {
  srt: string;
}

export async function transcribeAudio(audioUrl: string): Promise<TranscribeResult> {
  const mode = process.env.DOCLING_MODE ?? 'local';
  console.log(`[transcribe] mode=${mode}`);

  if (mode === 'local') {
    return transcribeLocal(audioUrl);
  } else {
    return transcribeSaas(audioUrl);
  }
}

// ---------------------------------------------------------------------------
// Local mode — run docling directly via uv + the reference project's venv
// ---------------------------------------------------------------------------

async function transcribeLocal(audioUrl: string): Promise<TranscribeResult> {
  // Resolve the actual file path from the local audio URL
  if (!audioUrl.startsWith('/api/recordings/audio/')) {
    throw new Error(`Local mode cannot transcribe remote URL: ${audioUrl}`);
  }

  const basename = decodeURIComponent(audioUrl.split('/').pop()!);
  const filepath = join(tmpdir(), basename);
  console.log(`[transcribe] Local — running docling on: ${filepath}`);

  const { stdout, stderr } = await execFileAsync(
    'uv',
    ['run', '--project', UV_PROJECT, 'python', SCRIPT_PATH, filepath],
    {
      timeout: POLL_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB — large transcripts
    },
  ).catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string }) => {
    throw new Error(
      `Docling transcription subprocess failed:\n${err.stderr ?? err.message}`
    );
  });

  if (stderr) {
    // uv and docling emit progress/model-download info to stderr — log but don't fail
    console.log(`[transcribe] docling stderr:\n${stderr.slice(0, 500)}`);
  }

  const text = stdout.trim();
  console.log(`[transcribe] Got transcript (${text.length} chars)`);
  if (!text) {
    throw new Error('Docling returned empty transcript');
  }

  return { srt: text };
}

// ---------------------------------------------------------------------------
// SaaS mode — IBM Docling for watsonx REST API
// ---------------------------------------------------------------------------

function getSaasConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.DOCLING_SERVICE_URL;
  if (!baseUrl) throw new Error('DOCLING_MODE=saas requires DOCLING_SERVICE_URL');
  const apiKey = process.env.DOCLING_API_KEY;
  if (!apiKey) throw new Error('DOCLING_MODE=saas requires DOCLING_API_KEY');
  return { baseUrl, apiKey };
}

async function transcribeSaas(audioUrl: string): Promise<TranscribeResult> {
  const { baseUrl, apiKey } = getSaasConfig();
  const headers = { 'X-Api-Key': apiKey };
  console.log(`[transcribe] SaaS — baseUrl=${baseUrl}`);

  let taskId: string;
  let res: Response;

  if (audioUrl.startsWith('/api/recordings/audio/')) {
    // Local file — read from tmpdir and upload directly as multipart
    const { readFile } = await import('fs/promises');
    const basename = decodeURIComponent(audioUrl.split('/').pop()!);
    const filepath = join(tmpdir(), basename);
    console.log(`[transcribe] SaaS multipart upload from: ${filepath}`);
    const fileBuffer = await readFile(filepath);
    // Use mp4 MIME for web recordings (.mp4), m4a for native (.m4a)
    const mimeType = filepath.endsWith('.mp4') ? 'video/mp4' : 'audio/m4a';
    const blob = new Blob([fileBuffer], { type: mimeType });
    const form = new FormData();
    form.append('files', blob, basename);
    form.append('from_formats', 'audio');
    form.append('to_formats', 'md');
    res = await fetch(`${baseUrl}/v1/convert/file/async`, {
      method: 'POST',
      headers,
      body: form,
    });
  } else {
    // Remote URL (Vercel Blob) — send as http_source
    const srcUrl = audioUrl;
    console.log(`[transcribe] SaaS remote URL: ${srcUrl}`);
    res = await fetch(`${baseUrl}/v1/convert/source/async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        http_sources: [{ url: srcUrl }],
        options: { from_formats: ['audio'], to_formats: ['md'] },
      }),
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Docling SaaS submit failed: ${res.status} ${body}`);
  }

  ({ task_id: taskId } = (await res.json()) as { task_id: string });
  console.log(`[transcribe] SaaS task submitted: ${taskId} — polling...`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const pollRes = await fetch(`${baseUrl}/v1/status/poll/${taskId}`, { headers });
    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`Docling SaaS poll failed: ${pollRes.status} ${body}`);
    }

    const status = (await pollRes.json()) as {
      task_status: 'pending' | 'started' | 'success' | 'failure';
    };
    console.log(`[transcribe] ${taskId} status: ${status.task_status}`);

    if (status.task_status === 'failure') throw new Error('Docling SaaS conversion failed');

    if (status.task_status === 'success') {
      const resultRes = await fetch(`${baseUrl}/v1/result/${taskId}`, { headers });
      if (!resultRes.ok) {
        const body = await resultRes.text();
        throw new Error(`Docling SaaS result fetch failed: ${resultRes.status} ${body}`);
      }

      const result = (await resultRes.json()) as Record<string, unknown>;
      const doc = result.document as Record<string, string> | undefined;
      const text = doc?.md_content ?? doc?.text_content ?? '';
      console.log(`[transcribe] Got transcript (${text.length} chars)`);
      if (!text) console.warn(`[transcribe] Empty transcript — result:`, JSON.stringify(result).slice(0, 500));
      return { srt: text };
    }
  }

  throw new Error('Docling SaaS transcription timed out after 10 minutes');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
