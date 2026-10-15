/**
 * pcm.ts
 *
 * Turns whatever the microphone delivers — Float32 from the web AudioWorklet,
 * Int16 from expo-audio's native AudioStream — into fixed 100 ms Int16 frames
 * with a running stream clock. One implementation so both platforms frame the
 * wire protocol identically: 8-byte header `[seq u32][t_ms u32]` is added by
 * the stream client, and `t_ms` comes from the sample count here.
 */

export interface FrameBatcher {
  /** Web path: Float32 samples in [-1, 1] at `sampleRate`. */
  pushFloat32(samples: Float32Array): void;
  /** Native path: little-endian Int16 samples at `sampleRate`. */
  pushInt16(samples: Int16Array): void;
  /** Emit the tail shorter than one frame (call at stop so audio is not lost). */
  flushPartial(): void;
  readonly sampleRate: number;
  readonly totalSamples: number;
}

export interface FrameBatcherOptions {
  sampleRate: number;
  /** frame is exactly 100 ms (or the remainder on flush); tMs is stream-relative. */
  onFrame: (frame: Int16Array, tMs: number) => void;
}

const FLUSH_INTERVAL_SAMPLES = 0.1; // 100 ms

export function createFrameBatcher(options: FrameBatcherOptions): FrameBatcher {
  const { sampleRate, onFrame } = options;
  const samplesPerFrame = Math.max(160, Math.round(sampleRate * FLUSH_INTERVAL_SAMPLES));
  const accumulator = new Int16Array(samplesPerFrame);
  let fill = 0;
  let totalSamples = 0;
  let emittedSamples = 0;

  const emit = () => {
    if (fill === 0) return;
    const frame = fill === samplesPerFrame ? accumulator.slice(0) : accumulator.slice(0, fill);
    const tMs = Math.round((emittedSamples * 1000) / sampleRate);
    emittedSamples += fill;
    fill = 0;
    onFrame(frame, tMs);
  };

  const put = (value: number) => {
    // Clamp and scale into Int16 range.
    const scaled = value >= 1 ? 32767 : value <= -1 ? -32768 : Math.round(value * 32767);
    accumulator[fill++] = scaled;
    totalSamples += 1;
    if (fill === samplesPerFrame) emit();
  };

  return {
    sampleRate,
    get totalSamples() {
      return totalSamples;
    },
    pushFloat32(samples: Float32Array) {
      for (let i = 0; i < samples.length; i += 1) put(samples[i]);
    },
    pushInt16(samples: Int16Array) {
      for (let i = 0; i < samples.length; i += 1) {
        accumulator[fill++] = samples[i];
        totalSamples += 1;
        if (fill === samplesPerFrame) emit();
      }
    },
    flushPartial: emit,
  };
}
