/* Turns the microphone stream into the mono 16 kHz 16-bit PCM the server
   forwards upstream, and reports a level so the screen can show that it is
   hearing something.

   Resampling happens here rather than on the main thread so a slow tablet
   drops frames of UI work, never frames of audio. */

const TARGET_RATE = 16000;
// ~64 ms per message: small enough to feel live, large enough that a cheap
// tablet is not posting hundreds of tiny buffers a second.
const FRAMES_PER_MESSAGE = 1024;

class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0;          // fractional read head into the input stream
    this.tail = new Float32Array(0);
    this.out = new Int16Array(FRAMES_PER_MESSAGE);
    this.filled = 0;
    this.peak = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    // Carry the unconsumed tail forward so the resampler never sees a seam.
    const buffer = new Float32Array(this.tail.length + channel.length);
    buffer.set(this.tail, 0);
    buffer.set(channel, this.tail.length);

    let read = this.position;
    while (read + 1 < buffer.length) {
      const index = Math.floor(read);
      const frac = read - index;
      const sample = buffer[index] * (1 - frac) + buffer[index + 1] * frac;

      const magnitude = Math.abs(sample);
      if (magnitude > this.peak) this.peak = magnitude;

      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.filled === FRAMES_PER_MESSAGE) {
        const copy = this.out.slice(0);
        this.port.postMessage({ audio: copy.buffer, peak: this.peak }, [copy.buffer]);
        this.filled = 0;
        this.peak = 0;
      }
      read += this.ratio;
    }

    const consumed = Math.floor(read);
    this.tail = buffer.subarray(consumed);
    this.position = read - consumed;
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
