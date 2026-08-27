/**
 * audio-wav.ts
 *
 * Web-only fallback that turns whatever MediaRecorder produced into a container
 * Docling's ASR pipeline accepts.
 *
 * Chrome's MediaRecorder can only encode Opus in a WebM (Matroska) container.
 * Docling classifies webm as InputFormat.VIDEO, so it is routed to VideoPipeline
 * and reaches ASR only if that deployment can demux a video track — which we
 * cannot verify from here. Relabelling the Blob's MIME type changes nothing:
 * the server identifies the container from magic bytes.
 *
 * So we decode the recording with the Web Audio API, which understands every
 * container the same browser can record, and re-encode it as 16 kHz mono
 * 16-bit PCM WAV. WAV is in Docling's audio extension list, and 16 kHz mono is
 * exactly what Whisper resamples to internally, so nothing is lost that the
 * model would have kept.
 *
 * The cost is size: PCM is uncompressed at ~32 KB/s, against ~4 KB/s for Opus.
 * That is why the upload ceiling is read from the server rather than hardcoded
 * — local disk storage can accept far more than a serverless request body.
 */

/** What Whisper resamples to anyway; encoding above this only inflates the upload. */
const TARGET_SAMPLE_RATE = 16000;

export interface TranscodedAudio {
  blob: Blob;
  mime: string;
  ext: string;
}

/**
 * Decodes `input` and re-encodes it as 16 kHz mono WAV. Throws with a message
 * naming the real cause if the browser cannot decode its own recording.
 */
export async function transcodeToWav(input: Blob): Promise<TranscodedAudio> {
  const AudioCtx: typeof AudioContext | undefined =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtx) {
    throw new Error('This browser has no Web Audio API, so the recording cannot be converted for transcription.');
  }

  const bytes = await input.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('The recording is empty — no audio was captured.');

  // A short-lived context purely for decoding. decodeAudioData resamples to the
  // context rate on some browsers, so the real rate is read back off the buffer.
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
  } catch (err) {
    throw new Error(
      `The browser could not decode its own recording (${
        err instanceof Error ? err.message : String(err)
      }). Try Safari or Firefox, which record a format the transcription service reads directly.`,
    );
  } finally {
    void decodeCtx.close();
  }

  if (decoded.length === 0) throw new Error('The recording decoded to zero samples — no audio was captured.');

  const mono = await toMono16k(decoded, AudioCtx);
  return { blob: encodeWav(mono, TARGET_SAMPLE_RATE), mime: 'audio/wav', ext: 'wav' };
}

/**
 * Downmixes to one channel and resamples to 16 kHz. OfflineAudioContext does the
 * resampling with a proper filter; averaging the channels first avoids the phase
 * cancellation that dropping to channel 0 would cause on some stereo sources.
 */
async function toMono16k(buffer: AudioBuffer, AudioCtx: typeof AudioContext): Promise<Float32Array> {
  const frames = Math.max(1, Math.ceil((buffer.duration * TARGET_SAMPLE_RATE) | 0) || 1);

  const OfflineCtx: typeof OfflineAudioContext | undefined =
    typeof OfflineAudioContext !== 'undefined'
      ? OfflineAudioContext
      : (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  if (OfflineCtx) {
    try {
      const offline = new OfflineCtx(1, frames, TARGET_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      return rendered.getChannelData(0).slice();
    } catch {
      // Safari historically rejects unusual target rates here; fall through to
      // the manual path rather than failing the whole upload.
    }
  }

  void AudioCtx;
  return manualDownsample(buffer);
}

/** Linear-interpolation fallback for browsers that refuse a 16 kHz OfflineAudioContext. */
function manualDownsample(buffer: AudioBuffer): Float32Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const ratio = buffer.sampleRate / TARGET_SAMPLE_RATE;
  const outLength = Math.max(1, Math.floor(buffer.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, buffer.length - 1);
    const frac = pos - lo;
    let sum = 0;
    for (const ch of channels) sum += ch[lo] * (1 - frac) + ch[hi] * frac;
    out[i] = sum / channels.length;
  }
  return out;
}

/** Writes a canonical 44-byte-header PCM WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric scaling: int16 reaches -32768 but only +32767.
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
