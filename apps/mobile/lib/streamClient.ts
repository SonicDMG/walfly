/**
 * streamClient.ts
 *
 * The audio WebSocket client: one connection per live session, binary PCM
 * frames to the ASR sidecar, results back as JSON control messages.
 *
 * Durability model (mirrors streaming-plan.md §3):
 *   - every 100 ms frame gets a monotone `seq` and is buffered locally until
 *     the sidecar acks it (ack = the frame's audio has been consumed);
 *   - on a drop the client reconnects with a fresh ticket, re-sends the buffer
 *     from `lastAck + 1`, and the sidecar dedupes by seq;
 *   - finalized `segment` events are handed to `onSegment`, which persists them
 *     through the Next.js API; the client ACKs a segment only after that write
 *     succeeds, so "acked" means "durable in Astra";
 *   - a segment lost to a sidecar restart/reconnect is re-numbered from the
 *     client's own `chunkIndex` base (the `ready.reset` flag tells us the
 *     server forgot the session).
 *
 * The client never decodes, chunks or gates anything — the sidecar owns all of
 * that. Its only jobs are framing, sequencing, retrying and bookkeeping.
 */

import type { StreamTicketResponse } from './api';

export type StreamConnectionState = 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface StreamPartial {
  revision: number;
  /** Session-clock seconds the committed text reaches. */
  tEnd: number;
  text: string;
}

export interface StreamSegment {
  /** Server-local sequence (used for acks and resume). */
  seq: number;
  /** Globally unique index for the recording, assigned by this client. */
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  avgLogprob?: number;
}

export interface AudioStreamClientOptions {
  sessionId: string;
  sampleRate: number;
  getTicket(): Promise<StreamTicketResponse>;
  onPartial?(partial: StreamPartial): void;
  /** Must persist the segment (POST /segments). The client acks only after it resolves. */
  onSegment(segment: StreamSegment): Promise<void>;
  onState?(state: StreamConnectionState, detail?: string): void;
  onGap?(fromMs: number, toMs: number): void;
  /** The sidecar ended the session by itself (idle timeout, capacity, deploy). */
  onEnded?(reason: 'server'): void;
}

const PROTOCOL_NAME = 'walfly.v1';
const HELLO_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 12_000;
const DEAD_SOCKET_MS = 20_000;
/** ~120 s of 100 ms frames; beyond this the oldest audio is dropped with a gap. */
const MAX_BUFFERED_FRAMES = 1200;
const STOP_FINAL_TIMEOUT_MS = 25_000;

type WsLike = {
  readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

export class AudioStreamClient {
  static async open(options: AudioStreamClientOptions): Promise<AudioStreamClient> {
    const client = new AudioStreamClient(options);
    await client._connect(true);
    return client;
  }

  private readonly _options: AudioStreamClientOptions;
  private _ws: WsLike | null = null;
  private _state: StreamConnectionState = 'connecting';
  private _seq = 0;
  private _totalSamples = 0;
  private _lastAudioAck = -1;
  /** Un-acked frames by seq, oldest first (Map preserves insertion order). */
  private readonly _buffer = new Map<number, Uint8Array>();
  /** Segment posts in flight; stop() waits for them before returning. */
  private readonly _segmentTasks = new Set<Promise<void>>();
  private readonly _failedSegments = new Map<number, StreamSegment>();
  private _heap: ReturnType<typeof setTimeout> | null = null;
  private _timers: ReturnType<typeof setInterval>[] = [];
  private _lastMessageAt = 0;
  private _retryDelayMs = 500;
  private _stopping = false;
  private _stopped = false;
  private _droppedFrames = 0;
  private _stopResolve: (() => void) | null = null;
  private _segmentsBase = 0;
  private _highestChunkIndex = -1;

  private constructor(options: AudioStreamClientOptions) {
    this._options = options;
  }

  get state(): StreamConnectionState {
    return this._state;
  }

  get lastAudioAck(): number {
    return this._lastAudioAck;
  }

  /** Frames captured but not yet acked (re-sent on reconnect). */
  get bufferedFrames(): number {
    return this._buffer.size;
  }

  /** Total audio frames captured this session. */
  get capturedFrames(): number {
    return this._seq;
  }

  /** Frames the sidecar has never consumed (unacked, including local drops). */
  get unackedFrames(): number {
    return Math.max(0, this._seq - (this._lastAudioAck + 1));
  }

  /** Frames thrown away because the local buffer overflowed during an outage. */
  get droppedFrames(): number {
    return this._droppedFrames;
  }

  // ── capture side ─────────────────────────────────────────────────────────

  push(frame: Int16Array): void {
    if (this._stopped || this._stopping) return;
    const seq = this._seq++;
    const bytes = new Uint8Array(8 + frame.byteLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, seq, true);
    view.setUint32(4, Math.round((this._totalSamples * 1000) / this._options.sampleRate) >>> 0, true);
    bytes.set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength), 8);
    this._totalSamples += frame.length;

    this._buffer.set(seq, bytes);
    while (this._buffer.size > MAX_BUFFERED_FRAMES) {
      const oldestKey = this._buffer.keys().next().value as number;
      const dropped = this._buffer.get(oldestKey);
      this._buffer.delete(oldestKey);
      this._droppedFrames += 1;
      if (dropped) {
        const fromMs = new DataView(dropped.buffer, dropped.byteOffset).getUint32(4, true);
        this._options.onGap?.(fromMs, fromMs + 100);
      }
    }

    if (this._state === 'live' && this._ws && this._ws.readyState === 1) {
      this._sendBinary(bytes);
    }
  }

  /** ACK a finalized segment (after its API write succeeded). */
  ack(seq: number): void {
    if (this._ws && this._ws.readyState === 1) {
      this._send({ t: 'ack', seq });
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Ends the stream: sends `bye`, waits for `final`, drains pending posts. */
  async stop(): Promise<void> {
    if (this._stopped || this._stopping) return;
    this._stopping = true;
    const finalArrived = new Promise<void>((resolve) => {
      this._stopResolve = resolve;
    });
    if (this._ws && this._ws.readyState === 1) {
      this._send({ t: 'bye', lastSeq: this._seq - 1 });
      await Promise.race([finalArrived, sleep(STOP_FINAL_TIMEOUT_MS)]);
    }
    this._stopped = true;
    this._clearTimers();
    this._closeSocket();
    await this._drainSegmentPosts(10_000);
  }

  /** Hard teardown without a `bye` (unmount, error paths). */
  close(): void {
    this._stopped = true;
    this._stopping = true;
    this._clearTimers();
    this._closeSocket();
  }

  /** Re-try posts that failed mid-session; called by stop() and the hook. */
  async drainPendingSegmentPosts(timeoutMs = 10_000): Promise<void> {
    await this._drainSegmentPosts(timeoutMs);
  }

  // ── connection internals ─────────────────────────────────────────────────

  private async _connect(initial: boolean): Promise<void> {
    this._setState(initial ? 'connecting' : 'reconnecting');
    let ticket: StreamTicketResponse;
    try {
      ticket = await this._options.getTicket();
    } catch (err) {
      this._setState('failed', err instanceof Error ? err.message : 'ticket request failed');
      this._scheduleReconnect();
      return;
    }

    const ws = new WebSocket(ticket.url, [PROTOCOL_NAME, `ticket.${ticket.ticket}`]) as unknown as WsLike;
    this._ws = ws;

    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('sidecar handshake timed out')), HELLO_TIMEOUT_MS);
      ws.onopen = () => {
        this._send({
          t: 'hello',
          sessionId: this._options.sessionId,
          codec: 'pcm_s16le',
          sampleRate: this._options.sampleRate,
          channels: 1,
          clientClockMs: Date.now(),
          ...(this._lastAudioAck >= 0 ? { resume: { fromSeq: this._lastAudioAck + 1 } } : {}),
        });
      };
      ws.onmessage = (event) => {
        const message = parseMessage(event.data);
        if (!message) return;
        this._lastMessageAt = Date.now();
        if (message.t === 'ready') {
          clearTimeout(timeout);
          if (message.reset) {
            // The sidecar lost the session (restart / expired): continue the
            // client's own chunk numbering so segment documents never collide.
            this._segmentsBase = this._highestChunkIndex + 1;
          }
          resolve();
          return;
        }
        if (message.t === 'error') {
          clearTimeout(timeout);
          this._setState('failed', typeof message.message === 'string' ? message.message : 'sidecar error');
          if (initial) reject(new Error(String(message.message ?? 'sidecar error')));
          return;
        }
        this._handleMessage(message);
      };
      ws.onerror = () => {
        // onclose follows; nothing to do here beyond unblocking the handshake.
      };
      ws.onclose = () => {
        clearTimeout(timeout);
        rejectOnce(new Error('socket closed before ready'));
        if (!this._stopped && !this._stopping) this._scheduleReconnect();
      };
      let rejected = false;
      const rejectOnce = (err: Error) => {
        if (!rejected) {
          rejected = true;
          reject(err);
        }
      };
    });

    try {
      await ready;
    } catch (err) {
      this._closeSocket();
      if (initial) {
        this._clearTimers();
        throw err;
      }
      this._scheduleReconnect();
      return;
    }

    // Handshake done — resume: re-send everything un-acked.
    this._state = 'live';
    this._retryDelayMs = 500;
    for (const [seq, bytes] of this._buffer) {
      if (seq > this._lastAudioAck) this._sendBinary(bytes);
    }
    this._startTimers();
    this._setState('live');
  }

  private _handleMessage(message: Record<string, unknown>): void {
    switch (message.t) {
      case 'partial': {
        this._options.onPartial?.({
          revision: Number(message.revision ?? 0),
          tEnd: Number(message.tEnd ?? 0),
          text: String(message.text ?? ''),
        });
        break;
      }
      case 'segment': {
        this._handleSegment(message);
        break;
      }
      case 'ack': {
        const seq = Number(message.seq ?? -1);
        if (Number.isFinite(seq) && seq > this._lastAudioAck) {
          this._lastAudioAck = seq;
          for (const key of this._buffer.keys()) {
            if (key <= seq) this._buffer.delete(key);
            else break;
          }
        }
        break;
      }
      case 'gap': {
        this._options.onGap?.(Number(message.fromMs ?? 0), Number(message.toMs ?? 0));
        break;
      }
      case 'final': {
        const wasStopping = this._stopping;
        this._stopResolve?.();
        this._stopResolve = null;
        if (!wasStopping && !this._stopped) {
          // The sidecar ended the session on its own (idle timeout, capacity,
          // max duration, deploy). Stop retrying and let the caller finalize
          // what is already durable instead of reconnecting into a dead session.
          this._stopped = true;
          this._clearTimers();
          this._closeSocket();
          this._options.onEnded?.('server');
        }
        break;
      }
      case 'flow':
      case 'pong':
        break;
      default:
        break;
    }
  }

  private _handleSegment(message: Record<string, unknown>): void {
    const seq = Number(message.seq ?? -1);
    if (!Number.isFinite(seq) || seq < 0) return;
    const chunkIndex = this._segmentsBase + seq;
    this._highestChunkIndex = Math.max(this._highestChunkIndex, chunkIndex);
    const segment: StreamSegment = {
      seq,
      chunkIndex,
      startMs: Math.max(0, Math.round(Number(message.start ?? 0) * 1000)),
      endMs: Math.max(0, Math.round(Number(message.end ?? 0) * 1000)),
      text: String(message.text ?? ''),
      ...(typeof message.avgLogprob === 'number' ? { avgLogprob: message.avgLogprob } : {}),
    };

    const task = (async () => {
      try {
        await this._options.onSegment(segment);
        this._failedSegments.delete(seq);
        this.ack(seq);
      } catch {
        // One inline retry; anything still failing is drained at stop().
        try {
          await sleep(1500);
          await this._options.onSegment(segment);
          this._failedSegments.delete(seq);
          this.ack(seq);
        } catch {
          this._failedSegments.set(seq, segment);
        }
      }
    })();
    this._segmentTasks.add(task);
    void task.finally(() => this._segmentTasks.delete(task));
  }

  private async _drainSegmentPosts(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await Promise.race([
      (async () => {
        while (this._segmentTasks.size > 0 && Date.now() < deadline) {
          await Promise.allSettled([...this._segmentTasks]);
        }
      })(),
      sleep(timeoutMs),
    ]);
    for (const [seq, segment] of [...this._failedSegments]) {
      if (Date.now() > deadline) break;
      try {
        await this._options.onSegment(segment);
        this._failedSegments.delete(seq);
        this.ack(seq);
      } catch {
        // Left in _failedSegments; finalize still proceeds with what we have.
      }
    }
  }

  // ── sockets, timers, backoff ─────────────────────────────────────────────

  private _startTimers(): void {
    this._clearTimers();
    this._lastMessageAt = Date.now();
    this._timers.push(setInterval(() => {
      if (this._ws && this._ws.readyState === 1) this._send({ t: 'ping', t0: Date.now() });
    }, PING_INTERVAL_MS));
    this._timers.push(setInterval(() => {
      if (this._state === 'live' && Date.now() - this._lastMessageAt > DEAD_SOCKET_MS) {
        // A dead TCP path can take minutes to notice; close deliberately.
        this._closeSocket();
        this._scheduleReconnect();
      }
    }, 3000));
  }

  private _clearTimers(): void {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    if (this._heap) {
      clearTimeout(this._heap);
      this._heap = null;
    }
  }

  private _scheduleReconnect(): void {
    if (this._stopped || this._stopping || this._heap) return;
    this._setState('reconnecting');
    const jitter = Math.random() * 250;
    const delay = Math.min(15_000, this._retryDelayMs) + jitter;
    this._retryDelayMs = Math.min(15_000, this._retryDelayMs * 1.7);
    this._heap = setTimeout(() => {
      this._heap = null;
      void this._connect(false);
    }, delay);
  }

  private _send(message: Record<string, unknown>): void {
    try {
      this._ws?.send(JSON.stringify(message));
    } catch {
      // Socket died between the readyState check and send; reconnect covers it.
    }
  }

  private _sendBinary(bytes: Uint8Array): void {
    try {
      this._ws?.send(bytes);
    } catch {
      // As above — the frame stays buffered and is re-sent on reconnect.
    }
  }

  private _closeSocket(): void {
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(1000);
    } catch {
      // Already closed.
    }
  }

  private _setState(state: StreamConnectionState, detail?: string): void {
    if (this._state === state && !detail) return;
    this._state = state;
    this._options.onState?.(state, detail);
  }
}

function parseMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
