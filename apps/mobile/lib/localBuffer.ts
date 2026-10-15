/**
 * localBuffer.ts
 *
 * The crash-safe local copy of every capture: one WAV file written while the
 * microphone runs, so nothing is lost when the sidecar, the network, or the app
 * itself goes away. Delivery is a separate concern (`lib/recoverClient.ts`).
 *
 *   Web    — OPFS through a dedicated worker (public/assets/audio/buffer-worker.js).
 *            The sync access handle is the only crash-safe append primitive:
 *            `createWritable()` discards its temp file when a tab dies open.
 *   Native — expo-file-system append handle; a 44-byte RIFF header is reserved
 *            up front and patched at stop (no 27 MB rewrite).
 *
 * Both platforms produce the same contract: `walfly-recordings/<id>.wav` (web:
 * an equivalent OPFS path) plus a metadata sidecar, and both make `finalize()`
 * the idempotent heal-and-commit step — a torn tail from a kill is truncated,
 * the header is corrected, and the true byte count is returned.
 */

import { Platform } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

// ─── OPFS typing shim ────────────────────────────────────────────────────────
// The DOM lib shipped with the React Native toolchain predates the File System
// Access API, so the two calls this module needs are declared locally.
interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  keys(): AsyncIterable<string>;
}
function opfsRoot(): Promise<OpfsDirectoryHandle> {
  const storage = navigator.storage as unknown as { getDirectory(): Promise<OpfsDirectoryHandle> };
  return storage.getDirectory();
}

export interface LocalBufferFile {
  ext: 'wav';
  /** Total file size in bytes (header + PCM). */
  bytes: number;
  durationSec: number;
}

export interface LocalBuffer {
  readonly recordingId: string;
  /** Hot path (~10/s): append one s16le frame. Must never throw. */
  append(frame: Int16Array): void;
  /** Flush, patch the WAV header, close the append handle. Idempotent. */
  finalize(): Promise<LocalBufferFile>;
  /** Web only — a Blob view of the file for uploads. Null on native. */
  getBlob(): Promise<Blob | null>;
  /** Native only — the file URI for uploads. Null on web. */
  getUri(): string | null;
  /** Removes the file and its metadata. */
  discard(): Promise<void>;
}

export async function createLocalBuffer(recordingId: string): Promise<LocalBuffer> {
  return Platform.OS === 'web'
    ? WebLocalBuffer.open(recordingId, 'create')
    : NativeLocalBuffer.open(recordingId, 'create');
}

/**
 * Opens a buffer left behind by a crash (or any earlier session) and heals it:
 * traverse/truncate whatever is there, so its bytes are upload-ready.
 */
export async function openExistingBuffer(recordingId: string): Promise<LocalBuffer> {
  return Platform.OS === 'web'
    ? WebLocalBuffer.open(recordingId, 'existing')
    : NativeLocalBuffer.open(recordingId, 'existing');
}

/** Recording ids that still have a buffer on this device. */
export async function listPendingBuffers(): Promise<string[]> {
  try {
    if (Platform.OS === 'web') {
      if (typeof navigator === 'undefined' || !(navigator.storage as unknown as { getDirectory?: unknown })?.getDirectory) {
        return [];
      }
      const root = await opfsRoot();
      let dir: OpfsDirectoryHandle;
      try {
        dir = await root.getDirectoryHandle('walfly-buffers');
      } catch {
        return [];
      }
      const ids: string[] = [];
      for await (const name of dir.keys()) ids.push(name);
      return ids;
    }

    const dir = new Directory(Paths.document, NATIVE_DIR);
    if (!dir.exists) return [];
    const ids: string[] = [];
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.endsWith('.wav')) {
        ids.push(entry.name.slice(0, -'.wav'.length));
      }
    }
    return ids;
  } catch (err) {
    console.warn('[LocalBuffer] listPendingBuffers failed:', err);
    return [];
  }
}

// ─── Web (OPFS in a worker) ──────────────────────────────────────────────────

const WORKER_URL = '/assets/audio/buffer-worker.js';

interface WorkerMessage {
  t: string;
  bytes?: number;
  durationSec?: number;
  blob?: Blob;
  message?: string;
}

class WebLocalBuffer implements LocalBuffer {
  static async open(recordingId: string, mode: 'create' | 'existing'): Promise<WebLocalBuffer> {
    const buffer = new WebLocalBuffer(recordingId);
    await buffer._opened(mode);
    return buffer;
  }

  readonly recordingId: string;
  private worker: Worker | null = null;
  private waiters = new Map<string, (message: WorkerMessage) => void>();
  private failed = false;
  private finalized = false;

  private constructor(recordingId: string) {
    this.recordingId = recordingId;
  }

  private async _opened(mode: 'create' | 'existing'): Promise<void> {
    if (
      typeof Worker === 'undefined' ||
      typeof navigator === 'undefined' ||
      !(navigator.storage as unknown as { getDirectory?: unknown })?.getDirectory
    ) {
      throw new Error('Local buffering is not available in this browser.');
    }
    this.worker = new Worker(WORKER_URL);
    this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => this._onMessage(event.data);
    this.worker.onerror = (event) => {
      this.failed = true;
      console.warn('[LocalBuffer] worker error:', event.message);
    };
    await this._request('opened', { t: 'open', recordingId: this.recordingId, mode });
  }

  private _onMessage(message: WorkerMessage): void {
    if (message.t === 'write-error') {
      this.failed = true;
      console.warn('[LocalBuffer] write failed; buffering is degraded:', message.message);
      return;
    }
    const waiter = this.waiters.get(message.t);
    if (waiter) {
      this.waiters.delete(message.t);
      waiter(message);
    }
  }

  private _request<T extends WorkerMessage>(responseType: string, message: object): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('buffer not open'));
    return new Promise<T>((resolve) => {
      this.waiters.set(responseType, resolve as (m: WorkerMessage) => void);
      worker.postMessage(message);
    });
  }

  append(frame: Int16Array): void {
    if (!this.worker || this.failed || this.finalized) return;
    try {
      // Copy: the frame may still be referenced by the live stream path, and a
      // 3.2 KB copy at 10 Hz is free.
      const copy = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
      this.worker.postMessage({ t: 'frame', ab: copy });
    } catch (err) {
      this.failed = true;
      console.warn('[LocalBuffer] append failed:', err);
    }
  }

  async finalize(): Promise<LocalBufferFile> {
    if (!this.worker) return { ext: 'wav', bytes: 0, durationSec: 0 };
    if (!this.finalized) {
      const result = await this._request<WorkerMessage & { bytes: number; durationSec: number }>('finalized', { t: 'finalize' });
      this.finalized = true;
      return { ext: 'wav', bytes: result.bytes ?? 0, durationSec: result.durationSec ?? 0 };
    }
    const size = await this._request<WorkerMessage & { bytes: number }>('size', { t: 'size' });
    return { ext: 'wav', bytes: size.bytes ?? 0, durationSec: (size.bytes ?? 0) > 44 ? ((size.bytes ?? 0) - 44) / 32000 : 0 };
  }

  async getBlob(): Promise<Blob | null> {
    if (!this.worker) return null;
    const result = await this._request<WorkerMessage>('blob', { t: 'blob' });
    return result.blob ?? null;
  }

  getUri(): string | null {
    return null;
  }

  async discard(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      await this._request('discarded', { t: 'discard' });
    } catch {
      // Already gone.
    }
    worker.terminate();
  }
}

// ─── Native (expo-file-system) ───────────────────────────────────────────────

const NATIVE_DIR = 'walfly-recordings';
const HEADER_BYTES = 44;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = (SAMPLE_RATE / 10) * BYTES_PER_SAMPLE;

class NativeLocalBuffer implements LocalBuffer {
  static async open(recordingId: string, mode: 'create' | 'existing'): Promise<NativeLocalBuffer> {
    return new NativeLocalBuffer(recordingId, mode);
  }

  readonly recordingId: string;
  private file: File;
  private handle: ReturnType<File['open']> | null = null;
  /** PCM bytes the header will declare (a torn tail is excluded from the header). */
  private pcmBytes = 0;
  /** PCM bytes physically present, torn tail included — what the server will stat. */
  private physicalPcmBytes = 0;
  private finalized = false;

  private constructor(recordingId: string, mode: 'create' | 'existing') {
    this.recordingId = recordingId;
    const dir = new Directory(Paths.document, NATIVE_DIR);
    dir.create({ intermediates: true, idempotent: true });
    this.file = new File(dir, `${recordingId}.wav`);

    if (mode === 'create') {
      // Fresh session id ⇒ overwrite is safe and keeps a stale file from a
      // reused id from ever leaking into this recording.
      this.file.create({ overwrite: true });
      this.handle = this.file.open(FileMode.Append);
      this.handle.writeBytes(wavHeader(0));
      this.pcmBytes = 0;
      this.physicalPcmBytes = 0;
    } else {
      if (!this.file.exists) throw new Error(`No local buffer for ${recordingId}`);
      // Heal a torn tail from a kill. SDK 57's FileHandle has no truncate(), so
      // the header is the authority: declare only whole frames and let the
      // stray tail bytes sit past the `data` chunk (every decoder honours it).
      const physical = Math.max(0, (this.file.size ?? 0) - HEADER_BYTES);
      const torn = physical % FRAME_BYTES;
      this.pcmBytes = physical - torn;
      this.physicalPcmBytes = physical;
      if (torn) {
        const patch = this.file.open(FileMode.ReadWrite);
        patch.offset = 0;
        patch.writeBytes(wavHeader(this.pcmBytes));
        patch.close();
      }
      this.handle = this.file.open(FileMode.Append);
    }
  }

  append(frame: Int16Array): void {
    const handle = this.handle;
    if (!handle || this.finalized) return;
    try {
      handle.writeBytes(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      this.pcmBytes += frame.byteLength;
      this.physicalPcmBytes += frame.byteLength;
    } catch (err) {
      // Never break the live stream because the tee failed.
      console.warn('[LocalBuffer] tee failed; streaming continues:', err);
    }
  }

  async finalize(): Promise<LocalBufferFile> {
    if (!this.finalized) {
      this.finalized = true;
      try {
        this.handle?.close();
      } catch {
        // Already closed by GC.
      }
      this.handle = null;
      const commit = this.file.open(FileMode.ReadWrite);
      commit.offset = 0;
      commit.writeBytes(wavHeader(this.pcmBytes));
      commit.close();
    }
    const bytes = HEADER_BYTES + this.physicalPcmBytes;
    return { ext: 'wav', bytes, durationSec: this.pcmBytes / (SAMPLE_RATE * BYTES_PER_SAMPLE) };
  }

  async getBlob(): Promise<Blob | null> {
    return null;
  }

  getUri(): string | null {
    return this.file.uri;
  }

  async discard(): Promise<void> {
    try {
      this.handle?.close();
    } catch {}
    this.handle = null;
    this.finalized = true;
    try {
      if (this.file.exists) this.file.delete();
    } catch (err) {
      console.warn('[LocalBuffer] discard failed:', err);
    }
  }
}

function wavHeader(dataBytes: number): Uint8Array {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}
