/**
 * storage.ts
 *
 * Where the audio bytes live. This is a pure storage concern with no effect on
 * transcription: our server always uploads the bytes to Docling as multipart,
 * so Docling never has to reach this URL.
 *
 *   BLOB_READ_WRITE_TOKEN set   → Vercel Blob, absolute https URL
 *   unset, running locally      → packages/api/.data/audio, served by
 *                                 /api/recordings/audio/<name>
 *   unset, running on Vercel    → hard error; the filesystem there is
 *                                 read-only and per-instance, so a silent
 *                                 fallback would lose every recording.
 *
 * loadAudio() resolves either URL form back to bytes, which is what makes the
 * pipeline identical in `next dev` and in production.
 */

import { del, put } from '@vercel/blob';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { resolve, sep } from 'path';

export const LOCAL_AUDIO_URL_PREFIX = '/api/recordings/audio/';

/**
 * Every outbound call in this codebase is bounded. A Blob download that accepts
 * the connection and then stalls would otherwise hold the /process invocation
 * open until the platform kills it, so the pipeline never gets to record the
 * failure and never gets to retry.
 */
const REMOTE_FETCH_TIMEOUT_MS = 60_000;

export type StorageMode = 'blob' | 'local';

export interface StoredAudio {
  url: string;
  contentType: string;
  bytes: number;
}

/** Extension → Content-Type for the local serve route. */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  webm: 'audio/webm',
};

/** Local filenames are flat and conservative so the serve route can validate them. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function storageMode(): StorageMode {
  return process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local';
}

export function contentTypeForExtension(ext: string): string {
  return EXTENSION_CONTENT_TYPES[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

/** Absolute directory holding locally stored audio. Never used in blob mode. */
export function localAudioDir(): string {
  return process.env.LOCAL_AUDIO_DIR
    ? resolve(process.env.LOCAL_AUDIO_DIR)
    : resolve(process.cwd(), '.data', 'audio');
}

/**
 * Resolves a local audio filename to an absolute path, or null when the name is
 * unsafe or escapes the audio directory. The serve route relies on this for its
 * path-traversal guard, so it must reject before touching the filesystem.
 */
export function localAudioPath(name: string): string | null {
  if (!name || name.includes('..') || !SAFE_NAME.test(name)) return null;
  const dir = localAudioDir();
  const path = resolve(dir, name);
  if (path !== dir && !path.startsWith(dir + sep)) return null;
  return path;
}

/**
 * Persists the audio. `key` is a logical path such as `recordings/<id>.m4a`;
 * in local mode the separators are flattened so the file stays a safe basename.
 */
export async function storeAudio(key: string, bytes: Uint8Array, contentType: string): Promise<StoredAudio> {
  const size = bytes.byteLength;

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(key, Buffer.from(bytes), {
      access: 'public',
      contentType,
      addRandomSuffix: false,
    });
    return { url: blob.url, contentType, bytes: size };
  }

  if (process.env.VERCEL) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is required when deployed to Vercel (the filesystem is read-only and per-instance).',
    );
  }

  const name = key.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = localAudioPath(name);
  if (!path) throw new Error(`Refusing to store audio under an unsafe name: ${key}`);

  await mkdir(localAudioDir(), { recursive: true });
  await writeFile(path, Buffer.from(bytes));

  return { url: `${LOCAL_AUDIO_URL_PREFIX}${encodeURIComponent(name)}`, contentType, bytes: size };
}

/**
 * Reads the audio back. The pipeline calls this and hands the bytes to Docling,
 * which is why a private or unreachable storage URL is never a problem.
 */
export async function loadAudio(audioUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (audioUrl.startsWith(LOCAL_AUDIO_URL_PREFIX)) {
    const name = decodeURIComponent(audioUrl.slice(LOCAL_AUDIO_URL_PREFIX.length));
    const path = localAudioPath(name);
    if (!path) throw new Error(`Unsafe local audio URL: ${audioUrl}`);
    // turbopackIgnore: the path is computed at runtime, and without this the
    // bundler traces the entire repository into the deployment output. This
    // branch only runs off-Vercel anyway; there, storeAudio requires Blob.
    const buffer = await readFile(/* turbopackIgnore: true */ path);
    return {
      bytes: new Uint8Array(buffer),
      contentType: contentTypeForExtension(extensionOf(name)),
    };
  }

  if (/^https?:\/\//i.test(audioUrl)) {
    let res: Response;
    try {
      res = await fetch(audioUrl, { signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
    } catch (cause) {
      // Named so the pipeline classifies it as retryable: the object is still
      // there and the next tick can try again.
      throw new TransientStorageError(`Downloading the stored audio from ${audioUrl} failed`, cause);
    }
    if (!res.ok) {
      const message = `Failed to download stored audio (${res.status}) from ${audioUrl}`;
      if (res.status >= 500 || res.status === 429) throw new TransientStorageError(message);
      throw new Error(message);
    }
    let buffer: ArrayBuffer;
    try {
      buffer = await res.arrayBuffer();
    } catch (cause) {
      throw new TransientStorageError(`Reading the stored audio body from ${audioUrl} failed`, cause);
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: res.headers.get('content-type') ?? contentTypeForExtension(extensionOf(audioUrl)),
    };
  }

  throw new Error(`Unrecognised audioUrl form: ${audioUrl}`);
}

/** Removes the stored object. Handles both the Blob and the local-file case. */
export async function deleteAudio(audioUrl: string): Promise<void> {
  if (audioUrl.startsWith(LOCAL_AUDIO_URL_PREFIX)) {
    const name = decodeURIComponent(audioUrl.slice(LOCAL_AUDIO_URL_PREFIX.length));
    const path = localAudioPath(name);
    if (!path) return;
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') throw err;
    });
    return;
  }

  if (/^https?:\/\//i.test(audioUrl)) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return;
    await del(audioUrl, { abortSignal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
  }
}

/**
 * A storage failure the pipeline should retry rather than treat as terminal:
 * the object is still there and the next tick can simply try again. The
 * pipeline's error classifier keys on `name`.
 */
export class TransientStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransientStorageError';
  }
}

function extensionOf(nameOrUrl: string): string {
  const withoutQuery = nameOrUrl.split(/[?#]/)[0];
  const base = withoutQuery.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
}
