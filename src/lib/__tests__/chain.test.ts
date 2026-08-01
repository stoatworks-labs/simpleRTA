import { describe, expect, it } from 'vitest';
import { buildBandPlan, integrateBands, powerToDb } from '../bands';
import { getFFT } from '../fft';
import { enbwBins, makeWindow, windowSums } from '../windows';
import type { Fraction } from '../../types';

const FS = 48000;

/** Deterministic pink-ish noise: Paul Kellett's filter on a seeded LCG. */
function pinkNoise(length: number, seed: number): Float64Array {
  const out = new Float64Array(length);
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x3fffffff) - 1;
  };
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = rand();
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.05;
    b6 = white * 0.115926;
  }
  return out;
}

function meanSquare(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return s / x.length;
}

/** The engine's path: window, transform, integrate into bands. */
function bandPowers(x: Float64Array, fraction: Fraction, fftSize: number) {
  const w = makeWindow('hann', fftSize);
  const { s2 } = windowSums(w);
  const y = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) y[i] = x[i] * w[i];

  const power = new Float64Array((fftSize >>> 1) + 1);
  getFFT(fftSize).powerSpectrum(y, s2, power);

  const plan = buildBandPlan(fraction, fftSize, FS, enbwBins(w));
  const bands = new Float64Array(plan.bands.length);
  integrateBands(plan, power, bands);

  let total = 0;
  for (const v of bands) total += v;

  // The same span measured straight off the spectrum, for comparison.
  const first = plan.bands[0];
  const last = plan.bands[plan.bands.length - 1];
  let raw = 0;
  for (let k = Math.ceil(first.flo / plan.binHz); k <= Math.floor(last.fhi / plan.binHz); k++) {
    raw += power[k];
  }
  return { plan, bands, total, raw };
}

describe('analysis chain', () => {
  const SIZE = 16384;

  it('agrees with the spectrum it came from, at every resolution', () => {
    const x = pinkNoise(SIZE, 1234);
    for (const f of ['1/3', '1/6', '1/12', '1/24', '1/48'] as Fraction[]) {
      const { total, raw } = bandPowers(x, f, SIZE);
      // Re-bucketing the same span of spectrum must not create or destroy
      // power, and that has to hold at 1/48 too — where most bands are
      // narrower than a bin — or the fine resolutions read high. A tenth of a
      // decibel is the half-bin treatment of the two outermost edges; the
      // seam-free integration in `integrateBands` is what keeps it there.
      expect(Math.abs(10 * Math.log10(total / raw)), f).toBeLessThan(0.1);
    }
  });

  it('reports the broadband level of the analysed signal', () => {
    // What the meter shows against what the band sum shows. The band sum
    // covers 20 Hz to 20 kHz; the RMS covers everything up to Nyquist, so the
    // band sum must come out at or below it — never above.
    const x = pinkNoise(SIZE, 4242);
    const rmsDb = 10 * Math.log10(meanSquare(x)) + 10 * Math.log10(2);
    const { total } = bandPowers(x, '1/12', SIZE);
    const bandDb = powerToDb(total);

    expect(bandDb).toBeLessThanOrEqual(rmsDb + 0.3);
    expect(bandDb).toBeGreaterThan(rmsDb - 3);
  });

  it('drops 3 dB when two decorrelated channels are averaged', () => {
    // This is the relationship between the per-channel meter and the RTA when
    // the analysis channel is L+R: the mean of two independent signals of
    // equal power has half the power of either.
    const l = pinkNoise(SIZE, 11111);
    const r = pinkNoise(SIZE, 99999);
    const mid = new Float64Array(SIZE);
    for (let i = 0; i < SIZE; i++) mid[i] = 0.5 * (l[i] + r[i]);

    const one = powerToDb(bandPowers(l, '1/12', SIZE).total);
    const both = powerToDb(bandPowers(mid, '1/12', SIZE).total);
    expect(one - both).toBeGreaterThan(2.4);
    expect(one - both).toBeLessThan(3.6);
  });

  it('holds the broadband level as the resolution changes', () => {
    // Splitting a band in two must split its power, not duplicate it. If this
    // drifts, the per-band levels are being treated as densities somewhere.
    //
    // Summed over a fixed 40 Hz - 16 kHz window rather than over every band:
    // the band tables do not start and end at the same frequencies at every
    // resolution, and on pink noise those few hertz at the bottom are worth
    // more than the effect being tested.
    const x = pinkNoise(SIZE, 777);
    const inWindow = (f: Fraction) => {
      const { plan, bands } = bandPowers(x, f, SIZE);
      let sum = 0;
      for (let i = 0; i < plan.bands.length; i++) {
        const b = plan.bands[i];
        if (b.flo >= 40 && b.fhi <= 16000) sum += bands[i];
      }
      return powerToDb(sum);
    };

    // The window still cannot be identical at every resolution — bands snap to
    // their own grid, so the selected span shifts by a fraction of a band. On
    // pink noise that is worth about a tenth of a decibel, and it is the floor
    // this test can assert to. A bucketing error would be decibels, not tenths.
    const coarse = inWindow('1/3');
    for (const f of ['1/6', '1/12', '1/24', '1/48'] as Fraction[]) {
      expect(Math.abs(inWindow(f) - coarse), f).toBeLessThan(0.2);
    }
  });
});
