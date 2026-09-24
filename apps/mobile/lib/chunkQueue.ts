/**
 * chunkQueue.ts
 *
 * Persistent, retry-resilient queue for uploading recording audio chunks.
 * Handles background chunk uploads, exponential backoff, and local cleanup.
 */

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
        formData.append('audio', chunk.blob, `chunk-${chunk.chunkIndex}.mp4`);
      } else if (chunk.uri) {
        formData.append('audio', {
          uri: chunk.uri,
          type: 'audio/mp4',
          name: `chunk-${chunk.chunkIndex}.mp4`,
        } as any);
      }

      const res = await fetch(apiUrl(`/api/recordings/${encodeURIComponent(chunk.recordingId)}/chunks`), {
        method: 'POST',
        body: formData,
      });

      return res.ok;
    } catch (err) {
      console.warn(`[ChunkQueue] Network error uploading chunk ${chunk.chunkIndex}:`, err);
      return false;
    }
  }
}

export const chunkUploadQueue = new ChunkUploadQueue();
