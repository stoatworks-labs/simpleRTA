/**
 * Fractional-octave band table and the FFT-bin mapping behind it.
 *
 * Bands are base-2 and anchored on 1 kHz for every resolution:
 *
 *     fc(k) = 1000 · 2^(k/N)          edges at fc · 2^(±1/2N)
 *
 * IEC 61260 puts 1 kHz at a band *edge* for even N (1/6, 1/12, 1/24, 1/48) and
 * at a band centre only for odd N. We centre on 1 kHz throughout, which is what
 * every RTA a user is likely to compare against does, and which keeps the band
 * centres nested as the resolution changes — switch 1/6 → 1/48 and every 1/6
 * centre is still there. The 1/3-octave set is unaffected either way and does
 * match IEC.
 */
import { FRACTIONS, type Fraction } from '../types';

export interface Band {
  /** Band index k, where fc = 1000 · 2^(k/N). */
  k: number;
  /** Centre frequency, Hz. */
  fc: number;
  /** Lower edge, Hz. */
  flo: number;
  /** Upper edge, Hz. */
  fhi: number;
  /** Display label. */
  label: string;
  /**
   * First FFT bin whose centre falls inside the band, and the last. `binLo >
   * binHi` means the band contains no bin centre at all.
   *
   * Informational: `integrateBands` integrates the spectrum between the band
   * edges rather than bucketing whole bins, so it does not use these. They say
   * how much measurement is actually behind a band, which is what the tests
   * and the under-resolved shading care about.
   */
  binLo: number;
  binHi: number;
}

export interface BandPlan {
  fraction: Fraction;
  fftSize: number;
  sampleRate: number;
  /** Window ENBW in bins — needed to turn one bin's power into a density. */
  enbw: number;
  /** Bin spacing, Hz. */
  binHz: number;
  bands: Band[];
  /**
   * Lowest centre frequency whose band is at least one window-widened bin
   * wide. Below this the display is interpolated rather than measured, and the
   * UI shades it. Infinity if no band qualifies.
   */
  resolvedAboveHz: number;
}

export const F_MIN = 20;
export const F_MAX = 20000;

/** ISO preferred labels for the 1/3-octave set — 31.5 rather than "31". */
const THIRD_OCTAVE_LABELS: Record<number, string> = {
  20: '20', 25: '25', 31.5: '31.5', 40: '40', 50: '50', 63: '63', 80: '80',
  100: '100', 125: '125', 160: '160', 200: '200', 250: '250', 315: '315',
  400: '400', 500: '500', 630: '630', 800: '800', 1000: '1k', 1250: '1.25k',
  1600: '1.6k', 2000: '2k', 2500: '2.5k', 3150: '3.15k', 4000: '4k',
  5000: '5k', 6300: '6.3k', 8000: '8k', 10000: '10k', 12500: '12.5k',
  16000: '16k', 20000: '20k',
};

/** The nominal (labelled) frequency for a computed 1/3-octave centre. */
function nominalThird(fc: number): string | undefined {
  let best: string | undefined;
  let bestErr = Infinity;
  for (const [nom, label] of Object.entries(THIRD_OCTAVE_LABELS)) {
    const err = Math.abs(Math.log2(Number(nom) / fc));
    if (err < bestErr) {
      bestErr = err;
      best = label;
    }
  }
  // 1/3 octave is a 26% step; anything inside 3% is unambiguously that band.
  return bestErr < 0.04 ? best : undefined;
}

export function formatHz(f: number): string {
  if (f >= 10000) return `${Math.round(f / 100) / 10}k`;
  if (f >= 1000) return `${Math.round(f / 10) / 100}k`;
  if (f >= 100) return `${Math.round(f)}`;
  if (f >= 10) return `${Math.round(f * 10) / 10}`;
  return `${Math.round(f * 100) / 100}`;
}

/**
 * A frequency readout to three significant figures, with its unit: "63.2 Hz",
 * "997 Hz", "2.47 kHz", "12.5 kHz". Rounded before the unit is chosen, so
 * 999.6 Hz reads "1.00 kHz" rather than "1000 Hz".
 */
export function formatPeakHz(hz: number): string {
  const v = Number(hz.toPrecision(3));
  if (v >= 1000) return `${(v / 1000).toPrecision(3)} kHz`;
  return `${v.toPrecision(3)} Hz`;
}

export function fractionDenominator(fraction: Fraction): number {
  return FRACTIONS[fraction];
}

/**
 * Build the band table for a resolution, transform size and sample rate.
 *
 * Bands are dropped if their upper edge exceeds Nyquist — a band that is only
 * half inside the measurable spectrum would read low, and reading low without
 * saying so is worse than not drawing it.
 */
export function buildBandPlan(
  fraction: Fraction,
  fftSize: number,
  sampleRate: number,
  enbw: number,
): BandPlan {
  const n = fractionDenominator(fraction);
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;
  const halfStep = Math.pow(2, 1 / (2 * n));
  const maxBin = fftSize >>> 1;

  const kStart = Math.ceil(n * Math.log2(F_MIN / 1000));
  const kEnd = Math.floor(n * Math.log2(F_MAX / 1000));

  const bands: Band[] = [];
  for (let k = kStart; k <= kEnd; k++) {
    const fc = 1000 * Math.pow(2, k / n);
    const flo = fc / halfStep;
    const fhi = fc * halfStep;
    if (fhi > nyquist) break;

    const binLo = Math.ceil(flo / binHz);
    const binHi = Math.min(maxBin, Math.floor(fhi / binHz));

    const label = (n === 3 ? nominalThird(fc) : undefined) ?? formatHz(fc);
    bands.push({ k, fc, flo, fhi, label, binLo, binHi });
  }

  // κ is the band's fractional width: bw = fc · κ.
  const kappa = halfStep - 1 / halfStep;
  const resolvedAboveHz = (enbw * binHz) / kappa;

  return { fraction, fftSize, sampleRate, enbw, binHz, bands, resolvedAboveHz };
}

/**
 * Integrate a bin power spectrum between two frequencies, both given in bin
 * indices, treating the spectrum as a piecewise-linear density sampled at the
 * bin centres.
 *
 * ∫ over a whole bin returns that bin's power, so integrating over a wide band
 * reproduces the sum of its bins; integrating over a band narrower than the
 * spacing returns a fair share of the bin it sits in. That single behaviour is
 * the point — see `integrateBands`.
 */
function integrateDensity(power: Float64Array, u0: number, u1: number): number {
  const last = power.length - 1;
  let a = Math.max(0, u0);
  const end = Math.min(last, u1);
  let sum = 0;

  while (a < end) {
    const k = Math.floor(a);
    const segEnd = Math.min(end, k + 1);
    const p0 = power[k];
    const p1 = k + 1 <= last ? power[k + 1] : p0;
    const t0 = a - k;
    const t1 = segEnd - k;
    // ∫ p0 + (p1−p0)·t dt, from t0 to t1
    sum += p0 * (t1 - t0) + ((p1 - p0) * (t1 * t1 - t0 * t0)) / 2;
    a = segEnd;
  }
  return sum;
}

/**
 * Integrate the bin power spectrum into band powers.
 *
 * Every band goes through the same integration, and that is deliberate. The
 * obvious implementation — sum the bins inside the band, and interpolate when
 * there are none — quietly double-counts: in the transition region a bin lands
 * inside one band while its neighbours, having no bin of their own, interpolate
 * from that very same bin. At 1/48 octave the overlap read more than a decibel
 * high across the bottom three octaves.
 *
 * Treating the spectrum as a density and integrating it between the band edges
 * has no seam. Adjacent bands consume adjacent, non-overlapping stretches of
 * spectrum, so power is conserved exactly however the bands fall relative to
 * the bins, and a wide band still reduces to the sum of the bins it covers.
 *
 * What it cannot do is invent resolution: below `BandPlan.resolvedAboveHz` the
 * bands are narrower than the transform's own filter, so neighbouring bands
 * report shares of one measurement rather than independent ones. The UI shades
 * that region instead of pretending otherwise.
 */
export function integrateBands(
  plan: BandPlan,
  power: Float64Array,
  out: Float64Array,
): void {
  const { bands, binHz } = plan;

  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    out[i] = integrateDensity(power, b.flo / binHz, b.fhi / binHz);
  }
}

/**
 * Locate the strongest spectral component, interpolated between bins.
 *
 * `power` is a bin power spectrum at `binHz` spacing. Returns null when the
 * spectrum is empty enough that naming a peak would be inventing one.
 *
 * DC and the first bins are skipped: a converter with any DC offset puts a
 * large value in bin 0, and the window smears it into bins 1 and 2 — enough
 * that a real tone loses to it. The search starts at the bottom of the
 * measurement range, and never below bin 3.
 */
export function dominantHz(power: Float64Array, binHz: number): number | null {
  const last = power.length - 1;
  if (last < 4) return null;
  const first = Math.max(3, Math.ceil(F_MIN / binHz));
  if (first >= last) return null;

  let best = first;
  for (let k = first + 1; k < last; k++) {
    if (power[k] > power[best]) best = k;
  }
  // Nothing worth naming.
  if (power[best] <= 1e-24) return null;

  // Parabolic interpolation on the log magnitudes of the three bins around
  // the peak. Logs rather than powers because the main lobe of a windowed
  // sinusoid is closer to a parabola in dB than in linear power, which is
  // what makes this accurate to a small fraction of a bin.
  const l = Math.log(Math.max(power[best - 1], 1e-30));
  const c = Math.log(Math.max(power[best], 1e-30));
  const r = Math.log(Math.max(power[best + 1], 1e-30));
  const denom = l - 2 * c + r;
  const delta =
    Math.abs(denom) < 1e-18 ? 0 : Math.min(0.5, Math.max(-0.5, (0.5 * (l - r)) / denom));
  return (best + delta) * binHz;
}

/** The tallest band on the RTA, and the frequency behind it. */
export interface PeakBand {
  /** Index into `BandPlan.bands`. */
  index: number;
  /**
   * Where the peak actually is, Hz. The band's centre, unless a distinct
   * spectral maximum — a tone, a ring, a hum — is what makes the band the
   * tallest, in which case that maximum, interpolated between bins.
   */
  hz: number;
}

/**
 * Name the tallest band, and where within it the peak sits.
 *
 * `bandPower` is the band table the RTA draws and `power` the bin spectrum it
 * was integrated from — both averaged the same way, so the readout settles at
 * the rate the display does. It names the bar the eye picks out as tallest,
 * so it can never disagree with the graph; and when a distinct peak in the
 * spectrum is what makes that bar the tallest, it gives the peak's frequency
 * to a fraction of a bin rather than the band's centre, which at 1/3 octave
 * is a quarter of an octave wide.
 *
 * The fine peak is only accepted when it lies inside the tallest band — a tone
 * is what makes its band the tallest, so its lobe's maximum sits inside the
 * band's edges. Anywhere else it is a different thing: on pink noise the
 * strongest bin sits at the bottom of the range whichever band is tallest, and
 * quoting it would name a place the display shows nothing special. The band
 * is widened by a bin on each side for the unresolved region, where a band is
 * narrower than the bins and a whole-bin quantisation decides which of
 * several bands sharing one measurement comes out tallest.
 */
export function peakBand(
  plan: BandPlan,
  bandPower: ArrayLike<number>,
  power: Float64Array,
): PeakBand | null {
  const { bands, binHz } = plan;
  const n = bands.length;
  if (n === 0) return null;

  let best = 0;
  for (let i = 1; i < n; i++) {
    if (bandPower[i] > bandPower[best]) best = i;
  }
  if (!(bandPower[best] > 1e-24)) return null;

  const b = bands[best];
  const fine = dominantHz(power, binHz);
  const hz =
    fine !== null && fine >= b.flo - binHz && fine <= b.fhi + binHz ? fine : b.fc;
  return { index: best, hz };
}

/**
 * Power → dBFS, on the convention that a full-scale sine reads 0 dB.
 *
 * A ±1.0 sine has a mean square of 0.5, so the +3.0103 dB offset is what turns
 * "RMS relative to full scale" into the peak-referenced dBFS that every meter
 * in a studio shows.
 */
export const FULL_SCALE_SINE_OFFSET_DB = 10 * Math.log10(2);

export function powerToDb(p: number): number {
  return 10 * Math.log10(Math.max(p, 1e-30)) + FULL_SCALE_SINE_OFFSET_DB;
}
