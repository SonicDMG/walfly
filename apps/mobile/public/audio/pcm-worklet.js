/**
 * pcm-worklet.js
 *
 * AudioWorklet processor that forwards raw microphone samples to the main
 * thread. It runs on the audio thread and posts 128-sample render quanta; the
 * main thread batches them into 100 ms frames (see lib/pcm.ts).
 *
 * Loaded by lib/webMic.ts via audioWorklet.addModule('/audio/pcm-worklet.js').
 */

class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length > 0) {
      // The render quantum buffer is reused — copy before posting.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
