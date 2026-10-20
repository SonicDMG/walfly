/**
 * storage.ts
 *
 * Where the audio bytes live. This is a pure storage concern with no effect on
 * transcription: our server always uploads the bytes to Docling as multipart,
 * so Docling never has to reach this URL.
 *
 *   S3_BUCKET set   → S3-compatible object storage (AWS S3 / Cloudflare R2 /
 *                      Backblaze B2 / MinIO), public-read bucket, absolute
 *                      https URL. The required backend for any host without a
 *                      guaranteed-persistent, single-instance filesystem.
 *   unset           → packages/api/.data/audio, served by
 *                      /api/recordings/audio/<name>. Local-dev convenience
 *                      only — not recommended in production, since an
 *                      ephemeral or multi-instance container loses it.
 *
 * loadAudio() resolves either URL form back to bytes, which is what makes the
 * pipeline identical in every mode.
 */

import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { resolve, sep } from 'path';

export const LOCAL_AUDIO_URL_PREFIX = '/api/recordings/audio/';

/**
 * Every outbound call in this codebase is bounded. A download that accepts
 * the connection and then stalls would otherwise hold the /process invocation
 * open until the platform kills it, so the pipeline never gets to record the
 * failure and never gets to retry.
 */
const REMOTE_FETCH_TIMEOUT_MS = 60_000;

export type StorageMode = 's3' | 'local';

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
  return process.env.S3_BUCKET ? 's3' : 'local';
}

export function contentTypeForExtension(ext: string): string {
  return EXTENSION_CONTENT_TYPES[ext.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

/** Absolute directory holding locally stored audio. Never used in s3 mode. */
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

let cachedS3Client: S3Client | undefined;

/** Lazily constructed so a local-mode deployment never needs S3 credentials. */
function s3Client(): S3Client {
  if (cachedS3Client) return cachedS3Client;

  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing.',
    );
  }

  const endpoint = process.env.S3_ENDPOINT?.trim();
  cachedS3Client = new S3Client({
    region: process.env.S3_REGION?.trim() || 'auto',
    credentials: { accessKeyId, secretAccessKey },
    // Path-style addressing is what R2/MinIO/B2 expect behind a custom endpoint;
    // real AWS S3 (no S3_ENDPOINT set) uses its normal virtual-hosted routing.
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  return cachedS3Client;
}

function s3Bucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error('S3_BUCKET is not configured');
  return bucket;
}

/**
 * S3-compatible `PutObject` responses don't reliably hand back a usable public
 * URL the way Vercel Blob's `put()` did, so the API constructs it itself. The
 * bucket must be configured for public read (bucket policy / public-access
 * toggle) — this app never signs or re-signs URLs.
 */
function s3PublicUrl(key: string): string {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'S3_PUBLIC_BASE_URL is not configured — set it to the public-read base the ' +
        'S3_BUCKET is reachable at (e.g. an R2 .r2.dev / custom domain, a MinIO ' +
        'public endpoint, or https://<bucket>.s3.<region>.amazonaws.com).',
    );
  }
  return `${base}/${key}`;
}

/** Strips the public base back off a stored URL to recover the object key. */
function s3KeyFromPublicUrl(url: string): string | null {
  const base = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
  if (base && url.startsWith(`${base}/`)) return url.slice(base.length + 1);
  return null;
}

/**
 * Persists the audio. `key` is a logical path such as `recordings/<id>.m4a`;
 * in local mode the separators are flattened so the file stays a safe basename.
 */
export async function storeAudio(key: string, bytes: Uint8Array, contentType: string): Promise<StoredAudio> {
  const size = bytes.byteLength;
  const mode = storageMode();
  console.log(`[${mode === 's3' ? 'S3' : 'local storage'}] storing audio key=${key} size=${size} bytes`);

  if (mode === 's3') {
    await s3Client().send(
      new PutObjectCommand({
        Bucket: s3Bucket(),
        Key: key,
        Body: Buffer.from(bytes),
        ContentType: contentType,
      }),
    );
    const url = s3PublicUrl(key);
    console.log(`[S3] stored → ${url}`);
    return { url, contentType, bytes: size };
  }

  const name = key.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = localAudioPath(name);
  if (!path) throw new Error(`Refusing to store audio under an unsafe name: ${key}`);

  await mkdir(localAudioDir(), { recursive: true });
  await writeFile(path, Buffer.from(bytes));

  const url = `${LOCAL_AUDIO_URL_PREFIX}${encodeURIComponent(name)}`;
  console.log(`[local storage] stored → ${url}`);
  return { url, contentType, bytes: size };
}

/**
 * Reads the audio back. The pipeline calls this and hands the bytes to Docling,
 * which is why a private or unreachable storage URL is never a problem.
 */
export async function loadAudio(audioUrl: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (audioUrl.startsWith(LOCAL_AUDIO_URL_PREFIX)) {
    console.log(`[local storage] loading audio from ${audioUrl}`);
    const name = decodeURIComponent(audioUrl.slice(LOCAL_AUDIO_URL_PREFIX.length));
    const path = localAudioPath(name);
    if (!path) throw new Error(`Unsafe local audio URL: ${audioUrl}`);
    // turbopackIgnore: the path is computed at runtime, and without this the
    // bundler traces the entire repository into the deployment output. This
    // branch only runs in local mode anyway; in s3 mode storeAudio never
    // produces a local-prefixed URL.
    const buffer = await readFile(/* turbopackIgnore: true */ path);
    const result = {
      bytes: new Uint8Array(buffer),
      contentType: contentTypeForExtension(extensionOf(name)),
    };
    console.log(`[local storage] loaded (${result.bytes.byteLength} bytes, ${result.contentType})`);
    return result;
  }

  if (/^https?:\/\//i.test(audioUrl)) {
    console.log(`[S3] loading audio from ${audioUrl}`);
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
    const result = {
      bytes: new Uint8Array(buffer),
      contentType: res.headers.get('content-type') ?? contentTypeForExtension(extensionOf(audioUrl)),
    };
    console.log(`[S3] loaded (${result.bytes.byteLength} bytes, ${result.contentType})`);
    return result;
  }

  throw new Error(`Unrecognised audioUrl form: ${audioUrl}`);
}

/**
 * Looks up a stored object by its logical pathname without downloading it.
 * Used by the recovery handshake to answer "are my bytes already there?";
 * a missing object returns null rather than throwing, because absence is a
 * normal state in that flow.
 */
export async function statStoredAudio(pathname: string): Promise<StoredAudio | null> {
  if (storageMode() === 's3') {
    try {
      const head = await s3Client().send(
        new HeadObjectCommand({ Bucket: s3Bucket(), Key: pathname }),
      );
      return {
        url: s3PublicUrl(pathname),
        contentType: head.ContentType ?? contentTypeForExtension(extensionOf(pathname)),
        bytes: head.ContentLength ?? 0,
      };
    } catch (err) {
      console.log(`[S3] head(${pathname}) → missing (${err instanceof Error ? err.message : err})`);
      return null;
    }
  }

  const name = pathname.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = localAudioPath(name);
  if (!path) return null;
  try {
    // turbopackIgnore: see the matching comment in loadAudio — the path is
    // computed at runtime and local mode never runs in the Docker image.
    const info = await stat(/* turbopackIgnore: true */ path);
    return {
      url: `${LOCAL_AUDIO_URL_PREFIX}${encodeURIComponent(name)}`,
      contentType: contentTypeForExtension(extensionOf(name)),
      bytes: info.size,
    };
  } catch {
    return null;
  }
}

/** Deletes a stored object by pathname — e.g. the loser of a duplicate delivery. */
export async function deleteStoredAudio(pathname: string): Promise<void> {
  if (storageMode() === 's3') {
    try {
      await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: pathname }));
    } catch (err) {
      console.warn(`[S3] deleteStoredAudio(${pathname}) failed:`, err);
    }
    return;
  }
  const name = pathname.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = localAudioPath(name);
  if (!path) return;
  await unlink(path).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== 'ENOENT') throw err;
  });
}

/** Removes the stored object. Handles both the s3 and the local-file case. */
export async function deleteAudio(audioUrl: string): Promise<void> {
  if (audioUrl.startsWith(LOCAL_AUDIO_URL_PREFIX)) {
    console.log(`[local storage] deleting audio at ${audioUrl}`);
    const name = decodeURIComponent(audioUrl.slice(LOCAL_AUDIO_URL_PREFIX.length));
    const path = localAudioPath(name);
    if (!path) return;
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') throw err;
    });
    console.log(`[local storage] deleted audio file`);
    return;
  }

  if (/^https?:\/\//i.test(audioUrl)) {
    console.log(`[S3] deleting audio at ${audioUrl}`);
    if (storageMode() !== 's3') return;
    const key = s3KeyFromPublicUrl(audioUrl);
    if (!key) {
      console.warn(`[S3] deleteAudio: could not derive an object key from ${audioUrl}`);
      return;
    }
    await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
    console.log(`[S3] deleted object`);
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
