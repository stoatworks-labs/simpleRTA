import { describe, expect, it } from 'vitest';
import { WINDOWS, enbwBins, makeWindow, windowSums, type WindowName } from '../windows';

describe('windows', () => {
  it('generates the periodic form, not the symmetric one', () => {
    // Periodic Hann starts at exactly zero and never repeats it at the end —
    // that asymmetry is the point. The symmetric form would be zero at both
    // ends and would bias the noise-power normalisation.
    const w = makeWindow('hann', 8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
    expect(w[7]).toBeCloseTo(w[1], 12);
  });

  it('rectangular is unity everywhere', () => {
    const w = makeWindow('rectangular', 16);
    for (const v of w) expect(v).toBe(1);
    const { s1, s2 } = windowSums(w);
    expect(s1).toBe(16);
    expect(s2).toBe(16);
  });

  // ENBW is what turns one bin's power into a spectral density, so a wrong
  // table entry would quietly shift every interpolated band. These are the
  // published values (Harris 1978); the generated coefficients must agree.
  it('matches the published ENBW for each window', () => {
    const size = 4096;
    for (const info of WINDOWS) {
      expect(enbwBins(makeWindow(info.name, size)), info.name).toBeCloseTo(info.enbw, 2);
    }
  });

  it('is non-negative and peaks in the middle for every window', () => {
    const size = 512;
    for (const info of WINDOWS) {
      const w = makeWindow(info.name, size);
      const mid = w[size / 2];
      for (const v of w) expect(v).toBeLessThanOrEqual(mid + 1e-12);
      // Flat-top is the one that legitimately goes negative in its skirts.
      if (info.name !== 'flat-top') {
        for (const v of w) expect(v).toBeGreaterThanOrEqual(-1e-12);
      }
    }
  });

  it('has unity coherent gain at the centre for the amplitude windows', () => {
    for (const name of ['hann', 'blackman-harris', 'flat-top'] as WindowName[]) {
      expect(makeWindow(name, 1024)[512], name).toBeCloseTo(1, 6);
    }
  });
});
