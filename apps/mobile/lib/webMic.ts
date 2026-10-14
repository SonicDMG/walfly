/**
 * webMic.ts
 *
 * Web microphone capture: getUserMedia → AudioWorklet Float32 tap (with a
 * ScriptProcessor fallback for browsers without AudioWorklet). This replaces
 * the old MediaRecorder chunk rotation — nothing is encoded or buffered on the
 * client; samples flow straight into the stream client's 100 ms frames.
 *
 * The browser is asked for 16 kHz directly; where that is honoured the browser
 * resamples for us. Where it is not (Firefox's known custom-rate +
 * getUserMedia mismatch), capture runs at the device rate and the actual rate
 * is reported to the sidecar, which resamples server-side.
 */

const WORKLET_URL = '/assets/audio/pcm-worklet.js';

export interface WebMicHandle {
  sampleRate: number;
  stop(): void;
}

export interface WebMicOptions {
  onSamples(samples: Float32Array, sampleRate: number): void;
}

export async function startWebMic(options: WebMicOptions): Promise<WebMicHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: 16000 });
  } catch {
    context = new AudioContext();
  }
  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      // Will run at the device rate; the sidecar resamples.
    }
  }
  const sampleRate = context.sampleRate;
  const source = context.createMediaStreamSource(stream);

  let workletNode: AudioWorkletNode | null = null;
  let scriptNode: ScriptProcessorNode | null = null;

  const handleSamples = (samples: Float32Array) => options.onSamples(samples, sampleRate);

  try {
    await context.audioWorklet.addModule(WORKLET_URL);
    workletNode = new AudioWorkletNode(context, 'pcm-tap');
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => handleSamples(event.data);
    source.connect(workletNode);
    // Worklets process only when connected to the graph; a silent sink keeps
    // the graph alive without playing the mic to the speakers.
    const sink = context.createGain();
    sink.gain.value = 0;
    workletNode.connect(sink);
    sink.connect(context.destination);
  } catch (err) {
    console.warn('[webMic] AudioWorklet unavailable, falling back to ScriptProcessor:', err);
    scriptNode = context.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (event) => {
      handleSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(scriptNode);
    const sink = context.createGain();
    sink.gain.value = 0;
    scriptNode.connect(sink);
    sink.connect(context.destination);
  }

  return {
    sampleRate,
    stop() {
      try {
        if (workletNode) {
          workletNode.port.onmessage = null;
          workletNode.disconnect();
          workletNode = null;
        }
        if (scriptNode) {
          scriptNode.onaudioprocess = null;
          scriptNode.disconnect();
          scriptNode = null;
        }
        source.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close().catch(() => {});
      } catch (err) {
        console.warn('[webMic] teardown error:', err);
      }
    },
  };
}
