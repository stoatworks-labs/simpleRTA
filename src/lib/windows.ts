/**
 * Analysis windows.
 *
 * Each window is generated periodically (denominator N, not N-1) because the
 * signal is assumed to continue past the frame — that is the correct form for
 * spectral analysis, and the one the published coefficients below assume.
 *
 * Two normalisation constants come out of every window and both matter:
 *   S1 = Σw[n]      coherent gain — correct for discrete tones
 *   S2 = Σw[n]²     noise-power gain — correct for broadband content
 * The RTA sums bins into bands, which is a noise measurement, so it uses S2.
 * S1 is kept because ENBW is derived from both.
 */
export type WindowName = 'hann' | 'hamming' | 'blackman-harris' | 'flat-top' | 'rectangular';

export interface WindowInfo {
  name: WindowName;
  label: string;
  /** Equivalent noise bandwidth, in bins. Widens the effective filter. */
  enbw: number;
  /** −3 dB main-lobe width in bins, for the resolution readout. */
  mainLobeDb3: number;
  /** Highest sidelobe, dB relative to the main lobe. */
  sidelobeDb: number;
  blurb: string;
}

export const WINDOWS: WindowInfo[] = [
  {
    name: 'hann',
    label: 'Hann',
    enbw: 1.5,
    mainLobeDb3: 1.44,
    sidelobeDb: -31.5,
    blurb: 'General purpose. The default for music and noise.',
  },
  {
    name: 'hamming',
    label: 'Hamming',
    enbw: 1.36,
    mainLobeDb3: 1.3,
    sidelobeDb: -42.7,
    blurb: 'Slightly sharper than Hann, with a sidelobe shelf.',
  },
  {
    name: 'blackman-harris',
    label: 'Blackman-Harris',
    enbw: 2.0,
    mainLobeDb3: 1.9,
    sidelobeDb: -92,
    blurb: '4-term. Buys −92 dB sidelobes with a wider main lobe — use it to see a small tone next to a loud one.',
  },
  {
    name: 'flat-top',
    label: 'Flat-top',
    enbw: 3.77,
    mainLobeDb3: 3.72,
    sidelobeDb: -93,
    blurb: 'Amplitude-accurate to ~0.01 dB regardless of where a tone falls between bins. Poor frequency resolution — for level calibration, not for looking at spectra.',
  },
  {
    name: 'rectangular',
    label: 'Rectangular',
    enbw: 1.0,
    mainLobeDb3: 0.89,
    sidelobeDb: -13.3,
    blurb: 'No window at all. Best resolution, worst leakage. Only correct for signals periodic in the frame.',
  },
];

export function windowInfo(name: WindowName): WindowInfo {
  const w = WINDOWS.find((x) => x.name === name);
  if (!w) throw new Error(`unknown window: ${name}`);
  return w;
}

function cosineSeries(n: number, N: number, a: number[]): number {
  let v = 0;
  for (let k = 0; k < a.length; k++) {
    v += (k % 2 === 0 ? 1 : -1) * a[k] * Math.cos((2 * Math.PI * k * n) / N);
  }
  return v;
}

/** Generate a window of `size` samples. */
export function makeWindow(name: WindowName, size: number): Float64Array {
  const w = new Float64Array(size);
  for (let n = 0; n < size; n++) {
    switch (name) {
      case 'rectangular':
        w[n] = 1;
        break;
      case 'hann':
        w[n] = cosineSeries(n, size, [0.5, 0.5]);
        break;
      case 'hamming':
        w[n] = cosineSeries(n, size, [0.54, 0.46]);
        break;
      case 'blackman-harris':
        w[n] = cosineSeries(n, size, [0.35875, 0.48829, 0.14128, 0.01168]);
        break;
      case 'flat-top':
        // SRS/HFT-style 5-term, normalised to unity coherent gain by a0.
        w[n] = cosineSeries(n, size, [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]);
        break;
    }
  }
  return w;
}

export interface WindowSums {
  s1: number;
  s2: number;
}

export function windowSums(w: Float64Array): WindowSums {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < w.length; i++) {
    s1 += w[i];
    s2 += w[i] * w[i];
  }
  return { s1, s2 };
}

/** Equivalent noise bandwidth in bins, computed from the actual coefficients. */
export function enbwBins(w: Float64Array): number {
  const { s1, s2 } = windowSums(w);
  return (w.length * s2) / (s1 * s1);
}
