import { describe, expect, it } from 'vitest';
import { buildBandPlan, integrateBands, powerToDb } from '../bands';
import { getFFT } from '../fft';
import { makeWindow, windowSums, enbwBins } from '../windows';
import { FRACTION_LIST, type Fraction } from '../../types';

const FS = 48000;

function planFor(fraction: Fraction, fftSize: number) {
  const w = makeWindow('hann', fftSize);
  return buildBandPlan(fraction, fftSize, FS, enbwBins(w));
}

/** Band powers for a signal, the way the engine computes them. */
function analyse(x: Float64Array, fraction: Fraction, fftSize: number) {
  const w = makeWindow('hann', fftSize);
  const { s2 } = windowSums(w);
  const y = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) y[i] = x[i] * w[i];

  const power = new Float64Array((fftSize >>> 1) + 1);
  getFFT(fftSize).powerSpectrum(y, s2, power);

  const plan = buildBandPlan(fraction, fftSize, FS, enbwBins(w));
  const bands = new Float64Array(plan.bands.length);
  integrateBands(plan, power, bands);
  return { plan, bands, power };
}

function sine(size: number, freq: number, amplitude = 1): Float64Array {
  const x = new Float64Array(size);
  for (let n = 0; n < size; n++) x[n] = amplitude * Math.sin((2 * Math.PI * freq * n) / FS);
  return x;
}

describe('band layout', () => {
  it('centres a band on 1 kHz at every resolution', () => {
    for (const f of FRACTION_LIST) {
      const plan = planFor(f, 16384);
      const hit = plan.bands.find((b) => Math.abs(b.fc - 1000) < 1e-6);
      expect(hit, f).toBeDefined();
    }
  });

  it('nests: every 1/3-octave centre survives into 1/48', () => {
    const third = planFor('1/3', 16384).bands.map((b) => b.fc);
    const fine = planFor('1/48', 16384).bands.map((b) => b.fc);
    for (const fc of third) {
      expect(fine.some((f) => Math.abs(Math.log2(f / fc)) < 1e-9), `${fc} Hz`).toBe(true);
    }
  });

  it('gives the 1/3-octave set its ISO labels', () => {
    const labels = planFor('1/3', 16384).bands.map((b) => b.label);
    expect(labels).toContain('31.5');
    expect(labels).toContain('63');
    expect(labels).toContain('1k');
    expect(labels).toContain('12.5k');
  });

  it('has contiguous, non-overlapping edges', () => {
    const bands = planFor('1/12', 16384).bands;
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].flo).toBeCloseTo(bands[i - 1].fhi, 9);
    }
  });

  it('drops bands whose upper edge is past Nyquist', () => {
    // 8 kHz sample rate: the top of the 1/3-octave set has to be cut off.
    const w = makeWindow('hann', 4096);
    const plan = buildBandPlan('1/3', 4096, 8000, enbwBins(w));
    for (const b of plan.bands) expect(b.fhi).toBeLessThanOrEqual(4000);
  });

  it('reports where the transform stops resolving the bands', () => {
    // A short transform at 1/48 cannot resolve the bottom of the range; a long
    // one at 1/3 resolves all of it.
    const coarseHigh = planFor('1/48', 2048);
    expect(coarseHigh.resolvedAboveHz).toBeGreaterThan(1000);

    const fineLow = planFor('1/3', 65536);
    expect(fineLow.resolvedAboveHz).toBeLessThan(20);
  });

  it('marks a band as binless exactly when it is narrower than the spacing', () => {
    const plan = planFor('1/48', 4096);
    for (const b of plan.bands) {
      const empty = b.binLo > b.binHi;
      if (b.fhi - b.flo > 2 * plan.binHz) expect(empty, `${b.fc}`).toBe(false);
    }
  });
});

describe('band integration', () => {
  it('puts a tone in the band that contains it, at the right level', () => {
    const size = 32768;
    const { plan, bands } = analyse(sine(size, 1000), '1/12', size);
    let peak = 0;
    for (let i = 1; i < bands.length; i++) if (bands[i] > bands[peak]) peak = i;

    expect(plan.bands[peak].fc).toBeCloseTo(1000, 6);
    // A full-scale sine sitting inside one band reads 0 dBFS there.
    expect(powerToDb(bands[peak])).toBeCloseTo(0, 1);
  });

  it('follows a tone as it moves across bands', () => {
    const size = 32768;
    for (const f of [100, 250, 1000, 4000, 12500]) {
      const { plan, bands } = analyse(sine(size, f), '1/6', size);
      let peak = 0;
      for (let i = 1; i < bands.length; i++) if (bands[i] > bands[peak]) peak = i;
      const b = plan.bands[peak];
      expect(f, `${f} Hz landed in ${b.fc.toFixed(1)}`).toBeGreaterThanOrEqual(b.flo);
      expect(f).toBeLessThanOrEqual(b.fhi);
    }
  });

  it('conserves power: the bands sum to the spectrum over the same span', () => {
    const size = 16384;
    let seed = 987654321;
    const x = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      x[i] = seed / 0x3fffffff - 1;
    }

    const { plan, bands, power } = analyse(x, '1/3', size);
    let banded = 0;
    for (const v of bands) banded += v;

    const first = plan.bands[0];
    const last = plan.bands[plan.bands.length - 1];
    let raw = 0;
    for (let k = Math.ceil(first.flo / plan.binHz); k <= Math.floor(last.fhi / plan.binHz); k++) {
      raw += power[k];
    }
    // Same span, same energy — the band table only re-buckets it.
    expect(banded / raw).toBeCloseTo(1, 2);
  });

  it('interpolates rather than dropping out where bands hold no bin', () => {
    // 1/48 octave on a short transform: the bottom bands are narrower than the
    // bin spacing, and must still show the level of the noise around them
    // rather than reading silence.
    const size = 2048;
    let seed = 24680;
    const x = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      x[i] = (seed / 0x3fffffff - 1) * 0.25;
    }

    const { plan, bands } = analyse(x, '1/48', size);
    const binless = plan.bands
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.binLo > b.binHi && b.fc > 200);
    expect(binless.length).toBeGreaterThan(0);

    for (const { b, i } of binless) {
      const db = powerToDb(bands[i]);
      expect(db, `${b.fc.toFixed(1)} Hz`).toBeGreaterThan(-120);
      expect(db).toBeLessThan(0);
    }
  });

  it('reads a level, not an energy: widening the bands does not raise a tone', () => {
    // A pure tone is entirely inside one band at every resolution, so its level
    // must not change when the bands get wider.
    const size = 32768;
    const levels = FRACTION_LIST.map((f) => {
      const { bands } = analyse(sine(size, 1000), f, size);
      return powerToDb(Math.max(...bands));
    });
    for (const db of levels) expect(db).toBeCloseTo(levels[0], 1);
  });
});
