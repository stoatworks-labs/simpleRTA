import { describe, expect, it } from 'vitest';
import { FFT, getFFT } from '../fft';
import { makeWindow, windowSums, type WindowName } from '../windows';
import { powerToDb } from '../bands';

const FS = 48000;

/** A sine that lands exactly on bin `k`, so there is nothing to leak. */
function binSine(size: number, k: number, amplitude = 1): Float64Array {
  const x = new Float64Array(size);
  for (let n = 0; n < size; n++) x[n] = amplitude * Math.sin((2 * Math.PI * k * n) / size);
  return x;
}

function applyWindow(x: Float64Array, w: Float64Array): Float64Array {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] * w[i];
  return y;
}

function totalPower(size: number, x: Float64Array, name: WindowName): number {
  const w = makeWindow(name, size);
  const { s2 } = windowSums(w);
  const out = new Float64Array((size >>> 1) + 1);
  getFFT(size).powerSpectrum(applyWindow(x, w), s2, out);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i];
  return sum;
}

describe('FFT', () => {
  it('rejects sizes that are not powers of two', () => {
    expect(() => new FFT(1000)).toThrow();
    expect(() => new FFT(1)).toThrow();
    expect(() => new FFT(4096)).not.toThrow();
  });

  it('transforms a DC signal to bin 0 only', () => {
    const size = 64;
    const re = new Float64Array(size).fill(1);
    const im = new Float64Array(size);
    new FFT(size).transform(re, im);
    expect(re[0]).toBeCloseTo(size, 9);
    for (let k = 1; k < size; k++) {
      expect(Math.hypot(re[k], im[k])).toBeLessThan(1e-9);
    }
  });

  it('puts a bin-centred sine in exactly that bin', () => {
    const size = 1024;
    const k = 37;
    const out = new Float64Array((size >>> 1) + 1);
    getFFT(size).powerSpectrum(binSine(size, k), size, out); // rectangular: S2 = N
    for (let i = 0; i < out.length; i++) {
      if (i === k) expect(out[i]).toBeCloseTo(0.5, 9);
      else expect(out[i]).toBeLessThan(1e-18);
    }
  });
});

describe('power scaling', () => {
  // The whole display hangs off this: a full-scale sine must read 0 dBFS, and
  // it must do so whatever the transform size or window, or the RTA's absolute
  // levels are meaningless.
  it('reads a full-scale sine as 0 dBFS at every transform size', () => {
    for (const size of [1024, 4096, 16384, 65536]) {
      const p = totalPower(size, binSine(size, size / 8), 'hann');
      expect(powerToDb(p)).toBeCloseTo(0, 2);
    }
  });

  it('reads a full-scale sine as 0 dBFS through every window', () => {
    const size = 8192;
    const windows: WindowName[] = ['hann', 'hamming', 'blackman-harris', 'flat-top', 'rectangular'];
    for (const name of windows) {
      const p = totalPower(size, binSine(size, 1024), name);
      expect(powerToDb(p), name).toBeCloseTo(0, 2);
    }
  });

  it('tracks amplitude: halving the signal drops the level by 6 dB', () => {
    const size = 4096;
    const full = powerToDb(totalPower(size, binSine(size, 512, 1), 'hann'));
    const half = powerToDb(totalPower(size, binSine(size, 512, 0.5), 'hann'));
    expect(full - half).toBeCloseTo(6.0206, 4);
  });

  it('conserves the power of broadband noise (Parseval)', () => {
    const size = 8192;
    // Deterministic pseudo-noise — a seeded LCG, so the test cannot flake.
    let seed = 12345;
    const x = new Float64Array(size);
    let meanSquare = 0;
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      x[i] = (seed / 0x3fffffff) - 1;
      meanSquare += x[i] * x[i];
    }
    meanSquare /= size;

    // Unwindowed, this is Parseval's theorem and holds to machine precision.
    expect(totalPower(size, x, 'rectangular')).toBeCloseTo(meanSquare, 12);

    // Windowed, it cannot: the window weights the middle of the frame more
    // heavily than the ends, so a single frame estimates the mean square of
    // *this* noise rather than reproducing it. A few percent is the variance of
    // one unaveraged frame, not an error in the scaling — the rectangular case
    // above is what pins the scaling.
    for (const name of ['hann', 'blackman-harris'] as WindowName[]) {
      const ratio = totalPower(size, x, name) / meanSquare;
      expect(ratio, name).toBeGreaterThan(0.95);
      expect(ratio, name).toBeLessThan(1.05);
    }
  });

  it('places a tone at the right frequency', () => {
    const size = 8192;
    const k = 341; // 341 · 48000/8192 = 1998.0 Hz
    const w = makeWindow('hann', size);
    const out = new Float64Array((size >>> 1) + 1);
    getFFT(size).powerSpectrum(applyWindow(binSine(size, k), w), windowSums(w).s2, out);

    let peak = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[peak]) peak = i;
    expect((peak * FS) / size).toBeCloseTo(1998, 0);
  });
});
