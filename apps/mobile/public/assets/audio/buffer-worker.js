/**
 * buffer-worker.js
 *
 * The OPFS writer for the local recording buffer. Lives in a worker because
 * `FileSystemSyncAccessHandle` is worker-only everywhere, and because this is
 * the one place in the client that must be crash-safe: with the sync handle,
 * every `write()` lands in the storage layer and `flush()` is the durability
 * barrier (≤ 1 s of audio is ever at risk), unlike `createWritable()`, whose
 * temp file is discarded when a tab dies with the stream open.
 *
 * File layout: `walfly-buffers/<recordingId>/audio.wav` — a 44-byte RIFF header
 * is reserved up front, PCM is appended after it, and the header is patched at
 * finalize (the same contract the native buffer implements).
 *
 * Message protocol (postMessage):
 *   main → worker  {t:'open', recordingId, mode:'create'|'existing'}
 *                  {t:'frame', ab}          (ArrayBuffer copy of one frame)
 *                  {t:'flush'}
 *                  {t:'finalize'}           (flush + patch header + close handle)
 *                  {t:'blob'}               (File handle → Blob, for uploads)
 *                  {t:'size'}
 *                  {t:'discard'}
 *   worker → main  {t:'opened', bytes, truncated}
 *                  {t:'flushed', bytes}
 *                  {t:'finalized', bytes, durationSec}
 *                  {t:'blob', blob}
 *                  {t:'size', bytes}
 *                  {t:'discarded'}
 *                  {t:'write-error', message}
 */

const ROOT_DIR = 'walfly-buffers';
const FILE_NAME = 'audio.wav';
const META_NAME = 'meta.json';
const HEADER_BYTES = 44;
const FLUSH_MS = 1000;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

let rootDirectory = null;
let recordingId = null;
let dirHandle = null;
let fileHandle = null;
let handle = null;

let pcmBytes = 0;
let fileBytes = 0; // header + pcm
let lastFlush = 0;
let writeErrorReported = false;
let closed = false;

self.onmessage = (event) => {
  const message = event.data || {};
  try {
    switch (message.t) {
      case 'open':
        void open(message.recordingId, message.mode === 'existing' ? 'existing' : 'create');
        break;
      case 'frame':
        onFrame(message.ab);
        break;
      case 'flush':
        onFlush();
        break;
      case 'finalize':
        void finalize();
        break;
      case 'blob':
        void sendBlob();
        break;
      case 'size':
        post({ t: 'size', bytes: fileBytes });
        break;
      case 'discard':
        void discard();
        break;
      default:
        break;
    }
  } catch (error) {
    post({ t: 'write-error', message: String((error && error.message) || error) });
  }
};

async function open(id, mode) {
  recordingId = id;
  rootDirectory = await navigator.storage.getDirectory();
  const root = await rootDirectory.getDirectoryHandle(ROOT_DIR, { create: true });
  dirHandle = await root.getDirectoryHandle(recordingId, { create: true });
  fileHandle = await dirHandle.getFileHandle(FILE_NAME, { create: true });
  handle = await fileHandle.createSyncAccessHandle();

  const size = handle.getSize();
  let truncated = 0;
  if (mode === 'create') {
    // Fresh recording: reserve the header, start clean.
    handle.truncate(0);
    handle.write(wavHeader(0), { at: 0 });
    pcmBytes = 0;
  } else {
    // Existing buffer: drop a torn tail (a kill can leave a partial frame).
    const misaligned = size - HEADER_BYTES > 0 ? (size - HEADER_BYTES) % (SAMPLE_RATE / 10 * BYTES_PER_SAMPLE) : 0;
    if (misaligned) {
      handle.truncate(size - misaligned);
      truncated = misaligned;
    }
    pcmBytes = Math.max(0, handle.getSize() - HEADER_BYTES);
  }
  fileBytes = HEADER_BYTES + pcmBytes;
  lastFlush = performance.now();
  await writeMeta('recording');
  post({ t: 'opened', bytes: fileBytes, truncated });
}

function onFrame(ab) {
  if (!handle || closed) return;
  const bytes = new Uint8Array(ab);
  const written = handle.write(bytes, { at: fileBytes });
  if (written !== bytes.byteLength) {
    throw new Error(`short write: ${written}/${bytes.byteLength}`);
  }
  pcmBytes += written;
  fileBytes += written;
  const now = performance.now();
  if (now - lastFlush >= FLUSH_MS) {
    onFlush();
  }
}

function onFlush() {
  if (!handle || closed) return;
  handle.flush();
  lastFlush = performance.now();
  void writeMeta('recording');
  post({ t: 'flushed', bytes: fileBytes });
}

async function finalize() {
  if (!handle || closed) {
    post({ t: 'finalized', bytes: fileBytes, durationSec: pcmDuration() });
    return;
  }
  closed = true;
  const header = wavHeader(pcmBytes);
  handle.write(header, { at: 0 });
  handle.flush();
  handle.close();
  handle = null;
  await writeMeta('stopped');
  post({ t: 'finalized', bytes: fileBytes, durationSec: pcmDuration() });
}

async function sendBlob() {
  const file = await fileHandle.getFile();
  post({ t: 'blob', blob: file });
}

async function discard() {
  if (handle && !closed) {
    try { handle.close(); } catch {}
    handle = null;
    closed = true;
  }
  if (rootDirectory) {
    const root = await rootDirectory.getDirectoryHandle(ROOT_DIR, { create: true });
    await root.removeEntry(recordingId, { recursive: true });
  }
  post({ t: 'discarded' });
}

async function writeMeta(state) {
  try {
    const metaHandle = await dirHandle.getFileHandle(META_NAME, { create: true });
    const writable = await metaHandle.createWritable();
    await writable.write(JSON.stringify({
      v: 1,
      recordingId,
      state,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      container: 'wav',
      headerBytes: HEADER_BYTES,
      fileBytes,
      pcmBytes,
      updatedAtMs: Date.now(),
    }));
    await writable.close();
  } catch {
    // meta.json is diagnostic; the audio file is the source of truth.
  }
}

function pcmDuration() {
  return pcmBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

function post(message) {
  self.postMessage(message);
}

// Never break the capture path with an uncaught worker error.
self.addEventListener('unhandledrejection', (event) => {
  if (!writeErrorReported) {
    writeErrorReported = true;
    post({ t: 'write-error', message: String((event.reason && event.reason.message) || event.reason) });
  }
});

function wavHeader(dataBytes) {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}
