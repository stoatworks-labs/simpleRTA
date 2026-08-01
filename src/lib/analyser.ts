/**
 * The measurement engine: audio graph, ring buffer, transform loop, averaging.
 *
 * Deliberately outside React. It runs on its own clock (one transform per hop,
 * driven by audio arriving from the worklet) while the UI draws on the display
 * clock, and every component reads the latest state through a ref inside
 * `requestAnimationFrame`. Pushing spectra through React state at 20-90 frames
 * a second would spend most of a core on reconciliation.
 */
import { buildBandPlan, integrateBands, powerToDb, type BandPlan } from './bands';
import { getFFT } from './fft';
import { makeWindow, windowSums, enbwBins } from './windows';
import { aWeightDb, cWeightDb } from './weighting';
import {
  AVERAGES,
  DEFAULT_SETTINGS,
  type AnalysisChannel,
  type ChannelLevel,
  type Settings,
  type SourceInfo,
} from '../types';

const WORKLET_URL = new URL('rta-worklet.js', document.baseURI).href;

/** Sample peak at or above this counts as a clip. */
const CLIP_THRESHOLD = 0.999;

const SILENCE_DB = -140;

/**
 * Spectra retained for the spectrograph to collect.
 *
 * Transforms can outrun the display — a short transform at 75% overlap produces
 * more frames a second than a 60 Hz screen has to show them in — so the
 * waterfall must be able to pick up the ones it missed rather than repeat the
 * latest, which would smear it in time.
 *
 * Sized for interruptions, not just for that: `requestAnimationFrame` stops
 * entirely while the tab is in the background, and the audio does not. 256
 * frames covers about 45 seconds of a default-sized transform. Beyond that the
 * waterfall genuinely loses history — as every waterfall in a background tab
 * does — and picks up from the newest frames it can still reach.
 */
export const SPECTRUM_SLOTS = 256;

export interface EngineState {
  plan: BandPlan;
  /** Averaged band level, dB, ready to draw. */
  bandsDb: Float32Array;
  /** Per-band peak hold, dB. Only updated while `settings.peakHold` is on. */
  peakDb: Float32Array;
  /** Broadband level from the summed band powers, dB. */
  broadbandDb: number;
  broadbandADb: number;
  broadbandCDb: number;
  /** Transforms accumulated since the last reset. */
  frames: number;
  /** Increments once per transform — the spectrograph uses it to add columns. */
  seq: number;
}

type Listener = () => void;

export class RtaEngine {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: AudioNode | null = null;
  private sink: GainNode | null = null;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private plan: BandPlan | null = null;

  // --- transform state, rebuilt whenever size/window/resolution changes ---
  private window: Float64Array = new Float64Array(0);
  private windowS2 = 1;
  private enbw = 1.5;
  private frame: Float64Array = new Float64Array(0);
  private power: Float64Array = new Float64Array(0);
  private bandPower: Float64Array = new Float64Array(0);
  private avgPower: Float64Array = new Float64Array(0);
  private peakPower: Float64Array = new Float64Array(0);
  private spectra: Float32Array = new Float32Array(0);

  // --- ring buffer of input samples, mixed to the analysis channel ---
  private ring = new Float64Array(0);
  private ringMask = 0;
  private written = 0;
  private nextFftEnd = 0;

  // --- metering, accumulated between UI reads ---
  private chPeak = new Float32Array(2);
  private chRms = new Float32Array(2);
  private clipped = [false, false];

  /** Rebuilt, never mutated wholesale — `rebuild()` assigns it. */
  state!: EngineState;
  info: SourceInfo = { kind: 'none', label: 'No source', channels: 0, sampleRate: 48000 };
  running = false;
  lastError: string | null = null;

  private listeners = new Set<Listener>();

  constructor() {
    this.rebuild(48000);
  }

  /** Subscribe to structural changes (source, plan, error) — not to spectra. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- settings

  getSettings(): Settings {
    return this.settings;
  }

  applySettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;

    const structural =
      next.fftSize !== prev.fftSize ||
      next.window !== prev.window ||
      next.fraction !== prev.fraction ||
      next.hopFraction !== prev.hopFraction;

    if (structural) {
      this.rebuild(this.info.sampleRate);
      this.resetAveraging();
      this.notify();
    }
    if (!next.peakHold && prev.peakHold) this.resetPeakHold();
  }

  private rebuild(sampleRate: number): void {
    const { fftSize, window: windowName, fraction } = this.settings;

    this.window = makeWindow(windowName, fftSize);
    this.windowS2 = windowSums(this.window).s2;
    this.enbw = enbwBins(this.window);

    this.frame = new Float64Array(fftSize);
    this.power = new Float64Array((fftSize >>> 1) + 1);

    this.plan = buildBandPlan(fraction, fftSize, sampleRate, this.enbw);
    const n = this.plan.bands.length;
    this.bandPower = new Float64Array(n);
    this.avgPower = new Float64Array(n);
    this.peakPower = new Float64Array(n);
    this.spectra = new Float32Array(SPECTRUM_SLOTS * n);

    // The ring must hold a whole transform plus a whole delivery block without
    // the tail being overwritten before it is read. Power of two for masking.
    let ringSize = 1;
    while (ringSize < fftSize * 2) ringSize <<= 1;
    this.ring = new Float64Array(ringSize);
    this.ringMask = ringSize - 1;
    this.written = 0;
    this.nextFftEnd = fftSize;

    this.state = {
      plan: this.plan,
      bandsDb: new Float32Array(n).fill(SILENCE_DB),
      peakDb: new Float32Array(n).fill(SILENCE_DB),
      broadbandDb: SILENCE_DB,
      broadbandADb: SILENCE_DB,
      broadbandCDb: SILENCE_DB,
      frames: 0,
      seq: this.state ? this.state.seq : 0,
    };
  }

  resetAveraging(): void {
    this.avgPower.fill(0);
    this.state.frames = 0;
  }

  resetPeakHold(): void {
    this.peakPower.fill(0);
    this.state.peakDb.fill(SILENCE_DB);
  }

  resetClip(): void {
    this.clipped = [false, false];
  }

  // ------------------------------------------------------------------ source

  /** Enumerate input devices. Labels are blank until permission is granted. */
  static async listInputs(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput');
  }

  async startDevice(deviceId?: string): Promise<void> {
    // Every processing option off. Echo cancellation, noise suppression and AGC
    // are gain- and spectrum-shaping filters; leaving any of them on makes the
    // analyser measure the browser's voice pipeline rather than the signal.
    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
      video: false,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getAudioTracks()[0];
    await this.attach(stream, {
      kind: 'device',
      label: track?.label || 'Audio input',
      deviceId,
      channels: 0,
      sampleRate: 0,
    });
  }

  /**
   * Capture a tab, window or the whole desktop's audio output.
   *
   * `video: true` is not optional — Chrome will not offer the audio-bearing
   * picker entries without a video track requested, so we ask for video and
   * throw the track away immediately. Firefox and Safari have no equivalent
   * and will reject or return an audio-less stream; the caller surfaces that.
   */
  async startDisplay(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: true,
    } as DisplayMediaStreamOptions);

    for (const v of stream.getVideoTracks()) {
      v.stop();
      stream.removeTrack(v);
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      throw new Error(
        'That capture has no audio track. Pick a browser tab and tick "Share tab audio" — window and full-screen capture cannot carry audio on most platforms.',
      );
    }
    await this.attach(stream, {
      kind: 'display',
      label: track.label || 'Shared tab audio',
      channels: 0,
      sampleRate: 0,
    });
  }

  /**
   * Analyse pink noise generated inside the page.
   *
   * A self-check with no hardware and no permission prompt: pink noise is flat
   * on a constant-percentage-bandwidth display, so a correct RTA draws a level
   * line at every resolution. If the trace tilts, the analyser is wrong — not
   * the room. It never reaches the speakers; the graph's only output is the
   * silent sink every source runs through.
   */
  async startTestSignal(): Promise<void> {
    await this.attach(null, {
      kind: 'test',
      label: 'Pink noise (internal)',
      channels: 2,
      sampleRate: 0,
    });
  }

  private async attach(stream: MediaStream | null, info: SourceInfo): Promise<void> {
    await this.stop();

    const track = stream?.getAudioTracks()[0] ?? null;
    const channels = track
      ? Math.max(1, Math.min(2, track.getSettings().channelCount ?? 2))
      : 2;

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(WORKLET_URL);
    if (ctx.state === 'suspended') await ctx.resume();

    const source = stream
      ? ctx.createMediaStreamSource(stream)
      : createPinkNoise(ctx, channels);
    const node = new AudioWorkletNode(ctx, 'rta-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { channels },
    });

    // A silent sink. A worklet with no path to the destination is not
    // guaranteed to be pulled; routing it through a zero gain keeps the graph
    // alive without putting the captured audio back out of the speakers —
    // which, on a live microphone, would be a feedback loop.
    const sink = ctx.createGain();
    sink.gain.value = 0;

    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    node.port.onmessage = (e) => this.onAudio(e.data);

    // A device can be unplugged and a shared tab can be closed; either ends the
    // track, and the UI has to stop claiming it is live.
    track?.addEventListener('ended', () => {
      void this.stop();
      this.notify();
    });

    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
    this.source = source;
    this.sink = sink;
    this.chPeak = new Float32Array(channels);
    this.chRms = new Float32Array(channels);
    this.clipped = new Array(channels).fill(false);
    this.info = { ...info, channels, sampleRate: ctx.sampleRate };
    this.running = true;
    this.lastError = null;

    this.rebuild(ctx.sampleRate);
    this.resetAveraging();
    this.resetPeakHold();
    this.notify();
  }

  async stop(): Promise<void> {
    this.node?.port.postMessage('stop');
    this.node?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();

    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
    this.running = false;
    this.info = { ...this.info, kind: 'none', label: 'No source', channels: 0 };
    this.chPeak.fill(0);
    this.chRms.fill(0);
  }

  // ------------------------------------------------------------- audio input

  private onAudio(msg: { chans: Float32Array[]; peak: Float32Array; rms: Float32Array; frames: number }): void {
    const { chans, peak, rms, frames } = msg;

    for (let c = 0; c < Math.min(this.chPeak.length, peak.length); c++) {
      if (peak[c] > this.chPeak[c]) this.chPeak[c] = peak[c];
      this.chRms[c] = rms[c];
      if (peak[c] >= CLIP_THRESHOLD) this.clipped[c] = true;
    }

    this.ingest(chans, frames, this.settings.channel);
    this.runTransforms();
  }

  private ingest(chans: Float32Array[], frames: number, which: AnalysisChannel): void {
    const ring = this.ring;
    const mask = this.ringMask;
    const l = chans[0];
    const r = chans.length > 1 ? chans[1] : chans[0];
    let w = this.written;

    if (which === 'left' || chans.length === 1) {
      for (let i = 0; i < frames; i++) ring[w++ & mask] = l[i];
    } else if (which === 'right') {
      for (let i = 0; i < frames; i++) ring[w++ & mask] = r[i];
    } else {
      // Mean, not sum: a mono signal present on both channels then reads the
      // same level as it does on one, instead of 6 dB high.
      for (let i = 0; i < frames; i++) ring[w++ & mask] = 0.5 * (l[i] + r[i]);
    }
    this.written = w;
  }

  /**
   * Run every transform whose window has fully arrived.
   *
   * Capped per delivery block: a short transform with 75% overlap can want more
   * frames than a display can show, and there is no point computing spectra
   * nobody will draw. When the cap bites we skip ahead rather than fall behind,
   * so the analyser stays live rather than lagging further and further.
   */
  private runTransforms(): void {
    const { fftSize, hopFraction } = this.settings;
    const hop = Math.max(1, Math.round(fftSize * hopFraction));
    const maxPerBlock = 4;

    let run = 0;
    while (this.nextFftEnd <= this.written) {
      if (run >= maxPerBlock) {
        const behind = this.written - this.nextFftEnd;
        this.nextFftEnd += Math.floor(behind / hop) * hop;
        break;
      }
      this.transformAt(this.nextFftEnd);
      this.nextFftEnd += hop;
      run++;
    }
  }

  private transformAt(end: number): void {
    const { fftSize } = this.settings;
    const ring = this.ring;
    const mask = this.ringMask;
    const win = this.window;
    const frame = this.frame;

    const start = end - fftSize;
    for (let i = 0; i < fftSize; i++) {
      frame[i] = ring[(start + i) & mask] * win[i];
    }

    getFFT(fftSize).powerSpectrum(frame, this.windowS2, this.power);
    integrateBands(this.plan!, this.power, this.bandPower);

    this.accumulate();
  }

  private accumulate(): void {
    const { averaging, fftSize, hopFraction, peakHold, calibrationDb } = this.settings;
    const n = this.bandPower.length;
    const st = this.state;

    st.frames++;

    if (averaging === 'inf') {
      const k = 1 / st.frames;
      for (let i = 0; i < n; i++) this.avgPower[i] += (this.bandPower[i] - this.avgPower[i]) * k;
    } else {
      const tau = AVERAGES[averaging];
      const hopSeconds = (fftSize * hopFraction) / this.info.sampleRate;
      const alpha = 1 - Math.exp(-hopSeconds / tau);
      // A first frame that starts from zero would take a whole time constant to
      // climb to the real value; seeding it means the display is right at once.
      const a = st.frames === 1 ? 1 : alpha;
      for (let i = 0; i < n; i++) this.avgPower[i] += (this.bandPower[i] - this.avgPower[i]) * a;
    }

    let total = 0;
    let totalA = 0;
    let totalC = 0;
    const bands = this.plan!.bands;
    for (let i = 0; i < n; i++) {
      const p = this.avgPower[i];
      st.bandsDb[i] = powerToDb(p) + calibrationDb;
      total += p;
      totalA += p * Math.pow(10, aWeightDb(bands[i].fc) / 10);
      totalC += p * Math.pow(10, cWeightDb(bands[i].fc) / 10);

      if (peakHold) {
        // Peak hold tracks the instantaneous band power, not the averaged one —
        // holding the average would just record how the average settled.
        if (this.bandPower[i] > this.peakPower[i]) this.peakPower[i] = this.bandPower[i];
        st.peakDb[i] = powerToDb(this.peakPower[i]) + calibrationDb;
      }
    }

    st.broadbandDb = powerToDb(total) + calibrationDb;
    st.broadbandADb = powerToDb(totalA) + calibrationDb;
    st.broadbandCDb = powerToDb(totalC) + calibrationDb;

    // Keep the frame for the waterfall to collect. `bandsDb` is overwritten by
    // the next transform, which may well happen before the display draws.
    const slot = (st.seq % SPECTRUM_SLOTS) * n;
    this.spectra.set(st.bandsDb, slot);
    st.seq++;
  }

  /**
   * The averaged spectrum of transform number `seq`, or null if it has already
   * been overwritten. `state.seq` is the sequence number the *next* transform
   * will get, so the newest available frame is `state.seq - 1`.
   */
  spectrumAt(seq: number): Float32Array | null {
    const st = this.state;
    const n = st.bandsDb.length;
    if (seq < 0 || seq >= st.seq || st.seq - seq > SPECTRUM_SLOTS) return null;
    const slot = (((seq % SPECTRUM_SLOTS) + SPECTRUM_SLOTS) % SPECTRUM_SLOTS) * n;
    return this.spectra.subarray(slot, slot + n);
  }

  // ---------------------------------------------------------------- metering

  /**
   * Peak and RMS since the previous call, in dBFS. Peak is the maximum over
   * every sample in the interval, so nothing gets past it between frames.
   */
  consumeLevels(): { levels: ChannelLevel[]; clipped: boolean[] } {
    const levels: ChannelLevel[] = [];
    const cal = this.settings.calibrationDb;
    for (let c = 0; c < this.chPeak.length; c++) {
      levels.push({
        peak: 20 * Math.log10(Math.max(this.chPeak[c], 1e-7)) + cal,
        rms: 20 * Math.log10(Math.max(this.chRms[c], 1e-7)) + cal,
      });
    }
    this.chPeak.fill(0);
    return { levels, clipped: [...this.clipped] };
  }
}

/**
 * Ten seconds of looping pink noise, one decorrelated channel per output.
 *
 * Paul Kellett's economy filter: a cascade of six one-pole sections whose time
 * constants are spread by decade, which tracks −3 dB/octave to within about
 * 0.05 dB from 10 Hz to the top of the audio band. Cheap enough to generate the
 * whole buffer up front, and exact enough that a tilt on the RTA means the
 * analyser is wrong rather than the source.
 *
 * Levelled to roughly −20 dBFS RMS: loud enough to sit well clear of the noise
 * floor, quiet enough that the peaks of a crest-factor-4 signal do not clip.
 */
function createPinkNoise(ctx: AudioContext, channels: number): AudioNode {
  const seconds = 10;
  const length = ctx.sampleRate * seconds;
  const buffer = ctx.createBuffer(channels, length, ctx.sampleRate);

  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.05;
      b6 = white * 0.115926;
    }
  }

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.start();
  return src;
}
