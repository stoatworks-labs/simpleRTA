/**
 * Iterative in-place radix-2 complex FFT.
 *
 * Why our own rather than `AnalyserNode.getFloatFrequencyData()`: the built-in
 * analyser caps `fftSize` at 32768, applies a Blackman window we cannot change,
 * and hands back a magnitude spectrum with smoothing already folded in. A 1/48
 * octave RTA needs a longer transform than that, a selectable window, and the
 * *unsmoothed* power spectrum so band powers can be summed correctly.
 *
 * Twiddles and the bit-reversal permutation are precomputed once per size; a
 * transform then allocates nothing, which matters when it runs every hop.
 */
export class FFT {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two >= 2, got ${size}`);
    }
    this.size = size;
    const levels = Math.log2(size) | 0;

    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.rev[i] = r;
    }

    const half = size >>> 1;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((2 * Math.PI * i) / size);
      this.sinTable[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  /** Forward transform, in place. `re` and `im` must both be `size` long. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error(`FFT.transform expects ${n}-length buffers`);
    }

    // bit-reversal permutation
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let span = 2; span <= n; span <<= 1) {
      const half = span >>> 1;
      const step = n / span;
      for (let i = 0; i < n; i += span) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const c = this.cosTable[k];
          const s = this.sinTable[k];
          const tre = re[l] * c + im[l] * s;
          const tim = -re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }

  /**
   * Power spectrum of a real signal, one value per bin from DC to Nyquist
   * (`size/2 + 1` values).
   *
   * `out[k]` is the mean-square (i.e. power) contained in bin k, scaled so that
   * a full-scale sine landing squarely on a bin sums to 0.5 across the spectrum
   * — its RMS squared. `bandLevelDb()` in bands.ts adds the +3.01 dB that turns
   * that into the 0 dBFS a full-scale sine is expected to read.
   *
   * `windowS2` is Σw[n]² for the window already applied to `real`. Normalising
   * by the sum of squares (not the sum) is what makes the result correct for
   * *noise*, which is what summing bins into an octave band assumes. Amplitude
   * normalisation (Σw) would be right for discrete tones and wrong here.
   */
  powerSpectrum(real: Float64Array, windowS2: number, out: Float64Array): void {
    const n = this.size;
    const bins = (n >>> 1) + 1;
    if (out.length !== bins) throw new Error(`powerSpectrum expects a ${bins}-length output`);

    const re = this.scratchRe ?? (this.scratchRe = new Float64Array(n));
    const im = this.scratchIm ?? (this.scratchIm = new Float64Array(n));
    re.set(real);
    im.fill(0);
    this.transform(re, im);

    // Welch's one-sided estimator: 2|X|²/(N·S2). The N is the DFT's own gain —
    // leave it out and every level scales with the transform size. DC and
    // Nyquist have no negative-frequency twin, so they lose the factor of 2.
    const scale = 2 / (n * windowS2);
    for (let k = 0; k < bins; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) * scale;
      out[k] = k === 0 || k === n / 2 ? p / 2 : p;
    }
  }

  private scratchRe?: Float64Array;
  private scratchIm?: Float64Array;
}

/** Cache of FFT instances — building the tables for 65536 is not free. */
const cache = new Map<number, FFT>();

export function getFFT(size: number): FFT {
  let f = cache.get(size);
  if (!f) {
    f = new FFT(size);
    cache.set(size, f);
  }
  return f;
}
