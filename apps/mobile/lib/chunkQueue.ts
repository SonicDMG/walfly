/**
 * chunkQueue.ts
 *
 * Persistent, retry-resilient queue for uploading recording audio chunks.
 * Handles background chunk uploads, exponential backoff, and local cleanup.
 */

import { File as ExpoFile } from 'expo-file-system';
import { apiUrl } from './api';

export interface QueuedChunk {
  recordingId: string;
  chunkIndex: number;
  offsetMs: number;
  duration: number;
  blob?: Blob;
  uri?: string;
  attempts: number;
}

class ChunkUploadQueue {
  private queue: QueuedChunk[] = [];
  private isProcessing = false;
  private onChunkUploadedCallbacks: Array<(recordingId: string, chunkIndex: number) => void> = [];

  public enqueue(chunk: QueuedChunk) {
    this.queue.push(chunk);
    this.processQueue();
  }

  public getPendingCount(): number {
    return this.queue.length;
  }

  public async drain(): Promise<void> {
    if (this.queue.length === 0 && !this.isProcessing) return;
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.queue.length === 0 && !this.isProcessing) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  public onChunkUploaded(callback: (recordingId: string, chunkIndex: number) => void) {
    this.onChunkUploadedCallbacks.push(callback);
    return () => {
      this.onChunkUploadedCallbacks = this.onChunkUploadedCallbacks.filter((cb) => cb !== callback);
    };
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      const success = await this.uploadChunkWithRetry(chunk);

      if (success) {
        this.queue.shift();
        this.onChunkUploadedCallbacks.forEach((cb) => cb(chunk.recordingId, chunk.chunkIndex));

        // Clean up temporary local chunk audio file if present
        if (chunk.uri) {
          try {
            const file = new ExpoFile(chunk.uri);
            if (file.exists) file.delete();
          } catch {
            // Best effort cleanup
          }
        }
      } else {
        chunk.attempts += 1;
        if (chunk.attempts > 5) {
          console.error(`[ChunkQueue] Dropping chunk ${chunk.chunkIndex} after 5 failed attempts`);
          this.queue.shift();
        } else {
          // Delay before retrying
          await new Promise((r) => setTimeout(r, Math.min(1000 * Math.pow(2, chunk.attempts), 10000)));
        }
      }
    }

    this.isProcessing = false;
  }

  private async uploadChunkWithRetry(chunk: QueuedChunk): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('chunkIndex', String(chunk.chunkIndex));
      formData.append('offsetMs', String(chunk.offsetMs));
      formData.append('duration', String(chunk.duration));

      if (chunk.blob) {
        const ext = chunk.blob.type.includes('wav')
          ? 'wav'
          : chunk.blob.type.includes('ogg')
          ? 'ogg'
          : chunk.blob.type.includes('mp4') || chunk.blob.type.includes('m4a')
          ? 'm4a'
          : 'webm';
        formData.append('audio', chunk.blob, `chunk-${chunk.chunkIndex}.${ext}`);
      } else if (chunk.uri) {
        const fileRef = new ExpoFile(chunk.uri);
        formData.append('audio', fileRef, `chunk-${chunk.chunkIndex}.mp4`);
      }

      const res = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(chunk.recordingId)}/chunks`), {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        console.warn(`[ChunkQueue] Upload failed for chunk ${chunk.chunkIndex} (HTTP ${res.status}): ${errorText.slice(0, 200)}`);
        return false;
      }

      return true;
    } catch (err) {
      console.warn(`[ChunkQueue] Network error uploading chunk ${chunk.chunkIndex}:`, err);
      return false;
    }
  }
}

export const chunkUploadQueue = new ChunkUploadQueue();
