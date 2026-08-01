/**
 * simpleRTA capture worklet.
 *
 * Plain JS on purpose: it is loaded by URL with `audioWorklet.addModule()`, not
 * bundled, so it must be valid as-is in the browser. Vite copies public/ into
 * dist/ untouched. If you move it, update WORKLET_URL in src/lib/analyser.ts.
 *
 * It does two jobs the main thread cannot do correctly:
 *
 *  1. Metering. Peak and RMS are computed over *every* sample. Sampling the
 *     signal once per animation frame would miss the transient that matters.
 *  2. Delivery. Audio arrives in 128-frame quanta; posting 375 messages a
 *     second is wasteful, so blocks are batched before they cross the thread.
 *
 * Nothing is analysed here — the FFT runs on the main thread, which is where
 * the window, transform size and averaging can change without rebuilding the
 * audio graph.
 */

const BATCH_FRAMES = 2048;

class RtaProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const channels = Math.max(1, Math.min(2, options?.processorOptions?.channels ?? 2));
    this.channels = channels;
    this.buffers = [];
    for (let c = 0; c < channels; c++) this.buffers.push(new Float32Array(BATCH_FRAMES));
    this.filled = 0;
    this.peak = new Float32Array(channels);
    this.sumSq = new Float64Array(channels);
    this.running = true;

    this.port.onmessage = (e) => {
      if (e.data === 'stop') this.running = false;
    };
  }

  process(inputs) {
    if (!this.running) return false;

    const input = inputs[0];
    if (!input || input.length === 0) {
      // No connected source this quantum. Report silence rather than freezing
      // the meter at its last value, which would read as a stuck signal.
      this.filled += 128;
      if (this.filled >= BATCH_FRAMES) this.flush(true);
      return true;
    }

    const frames = input[0].length;
    let offset = 0;

    while (offset < frames) {
      const room = BATCH_FRAMES - this.filled;
      const n = Math.min(room, frames - offset);

      for (let c = 0; c < this.channels; c++) {
        const src = input[Math.min(c, input.length - 1)];
        const dst = this.buffers[c];
        let peak = this.peak[c];
        let sum = this.sumSq[c];
        for (let i = 0; i < n; i++) {
          const s = src[offset + i];
          dst[this.filled + i] = s;
          const a = s < 0 ? -s : s;
          if (a > peak) peak = a;
          sum += s * s;
        }
        this.peak[c] = peak;
        this.sumSq[c] = sum;
      }

      this.filled += n;
      offset += n;
      if (this.filled >= BATCH_FRAMES) this.flush(false);
    }

    return true;
  }

  flush(silent) {
    const frames = this.filled;
    const chans = [];
    for (let c = 0; c < this.channels; c++) {
      const copy = silent ? new Float32Array(frames) : this.buffers[c].slice(0, frames);
      chans.push(copy);
    }

    const peak = new Float32Array(this.channels);
    const rms = new Float32Array(this.channels);
    for (let c = 0; c < this.channels; c++) {
      peak[c] = silent ? 0 : this.peak[c];
      rms[c] = silent ? 0 : Math.sqrt(this.sumSq[c] / frames);
    }

    const transfer = chans.map((a) => a.buffer);
    transfer.push(peak.buffer, rms.buffer);
    this.port.postMessage({ chans, peak, rms, frames }, transfer);

    this.filled = 0;
    this.peak.fill(0);
    this.sumSq.fill(0);
  }
}

registerProcessor('rta-capture', RtaProcessor);
