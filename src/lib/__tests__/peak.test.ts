import { describe, expect, it } from 'vitest';
import { buildBandPlan, dominantHz, formatPeakHz, integrateBands, peakBand } from '../bands';
import { getFFT } from '../fft';
import { enbwBins, makeWindow, windowSums } from '../windows';
import type { Fraction } from '../../types';

const FS = 48000;
const SIZE = 16384;

/** Band powers and the bin spectrum, the way the engine computes them. */
function analyse(x: Float64Array, fraction: Fraction) {
  const w = makeWindow('hann', SIZE);
  const { s2 } = windowSums(w);
  const y = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) y[i] = x[i] * w[i];

  const power = new Float64Array((SIZE >>> 1) + 1);
  getFFT(SIZE).powerSpectrum(y, s2, power);

  const plan = buildBandPlan(fraction, SIZE, FS, enbwBins(w));
  const bands = new Float64Array(plan.bands.length);
  integrateBands(plan, power, bands);
  return { plan, bands, power };
}

function sine(
  freq: number,
  amplitude = 1,
  into: Float64Array = new Float64Array(SIZE),
): Float64Array {
  for (let n = 0; n < SIZE; n++) into[n] += amplitude * Math.sin((2 * Math.PI * freq * n) / FS);
  return into;
}

describe('dominant frequency', () => {
  it('is interpolated between bins', () => {
    // Bins are 2.93 Hz apart here, so anything better than a hertz proves the
    // parabola is doing its job rather than the bin grid.
    for (const tone of [100, 997, 1000, 4321]) {
      const { plan, power } = analyse(sine(tone, 0.5), '1/3');
      const got = dominantHz(power, plan.binHz);
      expect(got, `${tone} Hz`).not.toBeNull();
      expect(Math.abs(got! - tone), `${tone} Hz`).toBeLessThan(1);
    }
  });

  it('is not dragged to DC by an offset', () => {
    const x = sine(1000, 0.2);
    for (let n = 0; n < SIZE; n++) x[n] += 0.9;
    const { plan, power } = analyse(x, '1/3');
    expect(Math.abs(dominantHz(power, plan.binHz)! - 1000)).toBeLessThan(5);
  });

  it('names nothing on silence', () => {
    const { plan, power } = analyse(new Float64Array(SIZE), '1/3');
    expect(dominantHz(power, plan.binHz)).toBeNull();
  });
});

describe('peak band', () => {
  it('names a tone precisely, from inside the band it tops', () => {
    // At 1/3 octave the 1 kHz band runs 891-1122 Hz; a readout that could only
    // say "1k" would be a quarter of an octave coarse. The refined frequency
    // must still belong to the band the bar is drawn for.
    for (const f of ['1/3', '1/12', '1/48'] as Fraction[]) {
      const { plan, bands, power } = analyse(sine(997, 0.5), f);
      const peak = peakBand(plan, bands, power);
      expect(peak, f).not.toBeNull();
      const b = plan.bands[peak!.index];
      expect(b.flo, f).toBeLessThanOrEqual(997);
      expect(b.fhi, f).toBeGreaterThanOrEqual(997);
      expect(Math.abs(peak!.hz - 997), f).toBeLessThan(1);
    }
  });

  it('still locates a tone where the bands are narrower than the bins', () => {
    // 60 Hz at 1/48 octave: the band is 0.87 Hz wide against 2.93 Hz bins, so
    // several bands share one bin's measurement and the tallest is whichever
    // the integration hands the biggest share. The readout must not be
    // pinned to that band's centre — the interpolated peak is the better
    // answer and lies within a bin of it.
    const { plan, bands, power } = analyse(sine(60, 0.5), '1/48');
    const peak = peakBand(plan, bands, power)!;
    expect(plan.resolvedAboveHz).toBeGreaterThan(60);
    expect(Math.abs(plan.bands[peak.index].fc - 60)).toBeLessThan(plan.binHz);
    expect(Math.abs(peak.hz - 60)).toBeLessThan(1);
  });

  it('falls back to the band centre when the spectrum peaks somewhere else', () => {
    // A strong low tone under a wide band of noise-like content. The 8 kHz
    // band holds the most power — it is the tallest bar — but the strongest
    // single bin is the 50 Hz tone. Quoting 50 Hz against a bar at 8 kHz
    // would be naming a place the graph shows nothing special.
    const x = sine(50, 0.5);
    for (let f = 7200; f <= 9200; f += 10) sine(f, 0.05, x);
    const { plan, bands, power } = analyse(x, '1/3');
    const peak = peakBand(plan, bands, power)!;
    const b = plan.bands[peak.index];
    expect(Math.abs(b.fc - 8000)).toBeLessThan(1e-6);
    expect(Math.abs(dominantHz(power, plan.binHz)! - 50)).toBeLessThan(1);
    expect(peak.hz).toBe(b.fc);
  });

  it('names nothing on silence', () => {
    const { plan, bands, power } = analyse(new Float64Array(SIZE), '1/12');
    expect(peakBand(plan, bands, power)).toBeNull();
  });
});

describe('formatPeakHz', () => {
  it('reads to three significant figures with the unit chosen after rounding', () => {
    expect(formatPeakHz(63.24)).toBe('63.2 Hz');
    expect(formatPeakHz(997.3)).toBe('997 Hz');
    expect(formatPeakHz(999.6)).toBe('1.00 kHz');
    expect(formatPeakHz(2468)).toBe('2.47 kHz');
    expect(formatPeakHz(12480)).toBe('12.5 kHz');
    expect(formatPeakHz(19.686)).toBe('19.7 Hz');
  });
});
