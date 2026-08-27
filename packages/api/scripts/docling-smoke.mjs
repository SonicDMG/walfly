/**
 * docling-smoke.mjs
 *
 * Answers one question before anyone debugs the pipeline: can the configured
 * Docling SaaS instance transcribe audio at all? It submits an audio file, polls
 * to a terminal state, fetches the result, and prints an explicit verdict.
 *
 * The default payload is a synthesised 1-second tone, which proves the WIRE
 * CONTRACT only — a working ASR deployment transcribes a tone to nothing, so an
 * empty transcript here is EXPECTED and proves nothing about ASR either way.
 * Pass a real speech recording to get an answer about ASR itself:
 *
 *   node scripts/docling-smoke.mjs                    # wire contract only
 *   node scripts/docling-smoke.mjs ./some-speech.m4a  # real ASR check
 *
 * Exit codes: 0 the check passed · 1 the check failed · 2 inconclusive
 * (the wire contract worked but nothing was proven about ASR).
 *
 * Reads packages/api/.env.local. Run it from packages/api, or via
 *   npm run smoke:docling --workspace=packages/api
 */

import { readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 2;

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

for (const line of safeRead(resolve(process.cwd(), '.env.local')).split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const base = (process.env.DOCLING_SERVICE_URL || '').replace(/\/+$/, '');
const key = process.env.DOCLING_API_KEY;
if (!base || !key) {
  console.error('Set DOCLING_SERVICE_URL and DOCLING_API_KEY in packages/api/.env.local');
  process.exit(EXIT_FAIL);
}

const sampleArg = process.argv[2];
const sample = sampleArg ? readSample(sampleArg) : syntheticSample();

console.log(`payload: ${sample.filename} (${sample.mime}, ${sample.bytes.byteLength} bytes)`);
console.log(sample.isSpeech ? 'mode: real audio — this DOES test ASR' : 'mode: synthetic tone — this tests the wire contract ONLY');
console.log('');

const form = new FormData();
form.append('files', new Blob([sample.bytes], { type: sample.mime }), sample.filename);
form.append('to_formats', 'md');
form.append('target_type', 'inbody');

const submit = await fetch(`${base}/v1/convert/file/async`, {
  method: 'POST', headers: { 'X-Api-Key': key }, body: form,
});
const submitBody = await submit.text();
console.log('submit', submit.status);
console.log(submitBody.slice(0, 800));

if (!submit.ok) {
  finish(EXIT_FAIL, [
    `The submit was rejected with HTTP ${submit.status}.`,
    submit.status === 415 || submit.status === 422
      ? 'A 415/422 on a plain WAV means this deployment will not accept audio at all — it cannot do ASR.'
      : 'Check DOCLING_SERVICE_URL (it must include the instance-id path segment) and DOCLING_API_KEY.',
  ]);
}

const taskId = JSON.parse(submitBody).task_id;
if (!taskId) finish(EXIT_FAIL, ['The submit succeeded but returned no task_id — this is not a docling-serve v1 endpoint.']);

let delay = 1000;
let terminal = null;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, delay));
  delay = Math.min(delay * 1.6, 15000);
  const poll = await fetch(`${base}/v1/status/poll/${taskId}`, { headers: { 'X-Api-Key': key } });
  const status = await poll.json().catch(() => ({}));
  console.log('poll', poll.status, status.task_status, status.error_message ?? '', JSON.stringify(status.failure ?? null));
  if (['success', 'partial_success', 'failure', 'skipped'].includes(status.task_status)) {
    terminal = status;
    break;
  }
}

if (!terminal) {
  finish(EXIT_FAIL, [
    `Task ${taskId} never reached a terminal status within the poll window (~2 minutes).`,
    'Either the instance is wedged or the queue is very deep. Re-run; if it repeats, the deployment is not usable.',
  ]);
}

if (terminal.task_status === 'failure' || terminal.task_status === 'skipped') {
  finish(EXIT_FAIL, [
    `Docling reported task_status "${terminal.task_status}".`,
    `failure=${JSON.stringify(terminal.failure ?? null)} error_message=${terminal.error_message ?? 'none'}`,
    'If the message mentions FFmpeg or Whisper, this deployment has no working ASR pipeline. No payload tuning fixes that;',
    'the follow-up is a dedicated STT provider behind the same three functions in packages/api/lib/transcribe.ts.',
  ]);
}

const result = await fetch(`${base}/v1/result/${taskId}`, { headers: { 'X-Api-Key': key } });
const resultText = await result.text();
console.log('result', result.status);
console.log(resultText.slice(0, 4000));

if (!result.ok) {
  finish(EXIT_FAIL, [`The task succeeded but /v1/result/${taskId} answered HTTP ${result.status}.`]);
}

let body = {};
try { body = JSON.parse(resultText); } catch { /* printed above */ }
const transcript = (body?.document?.md_content ?? body?.document?.text_content ?? '').trim();
const mentionsAsrProblem = /ffmpeg|whisper|asr/i.test(resultText);

if (transcript) {
  finish(EXIT_PASS, [
    `A transcript came back (${transcript.length} chars${/\[time:/i.test(transcript) ? ', with [time: ...] segment markers' : ''}).`,
    'ASR works on this deployment.',
  ]);
}

if (mentionsAsrProblem) {
  finish(EXIT_FAIL, [
    'The result is empty AND the payload mentions ffmpeg/whisper/asr.',
    'This deployment cannot transcribe audio. Read the raw body above for the exact message.',
  ]);
}

finish(
  sample.isSpeech ? EXIT_FAIL : EXIT_INCONCLUSIVE,
  sample.isSpeech
    ? [
        'The task succeeded but the transcript is EMPTY for a real speech recording.',
        'That is an ASR failure: either the pipeline is not running Whisper, or it silently discarded the audio.',
      ]
    : [
        'The wire contract works: submit, poll and result all behaved as expected.',
        'The transcript is empty, which is EXPECTED for a synthetic tone and proves NOTHING about ASR.',
        'Re-run with a few seconds of real speech to actually verify ASR:',
        '  node scripts/docling-smoke.mjs ./my-voice-memo.m4a',
      ],
);

// ── helpers ────────────────────────────────────────────────────────────────

function readSample(path) {
  const abs = resolve(process.cwd(), path);
  let bytes;
  try {
    bytes = new Uint8Array(readFileSync(abs));
  } catch (err) {
    console.error(`Could not read ${abs}: ${err.message}`);
    process.exit(EXIT_FAIL);
  }
  const ext = extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    console.error(`Unsupported extension "${ext}". Use one of: ${Object.keys(MIME_BY_EXT).join(', ')}`);
    process.exit(EXIT_FAIL);
  }
  return { bytes, mime, filename: basename(abs), isSpeech: true };
}

function syntheticSample() {
  return { bytes: makeWav(16000, 1.0), mime: 'audio/wav', filename: 'smoke.wav', isSpeech: false };
}

/** 16-bit PCM mono WAV containing a quiet 440 Hz tone. */
function makeWav(rate, seconds) {
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000), 44 + i * 2);
  return new Uint8Array(buf);
}

function finish(code, lines) {
  const verdict = code === EXIT_PASS ? 'PASS' : code === EXIT_FAIL ? 'FAIL' : 'INCONCLUSIVE';
  console.log('');
  console.log('--- verdict ----------------------------------------------------------');
  console.log(verdict);
  for (const line of lines) console.log(line);
  process.exit(code);
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
