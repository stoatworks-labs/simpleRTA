import type { WindowName } from './lib/windows';

/** Octave fractions offered by the resolution control. */
export const FRACTIONS = {
  '1/3': 3,
  '1/6': 6,
  '1/12': 12,
  '1/24': 24,
  '1/48': 48,
} as const;

export type Fraction = keyof typeof FRACTIONS;
export const FRACTION_LIST = Object.keys(FRACTIONS) as Fraction[];

export const FFT_SIZES = [2048, 4096, 8192, 16384, 32768, 65536] as const;
export type FftSize = (typeof FFT_SIZES)[number];

/**
 * Exponential averaging time constants, in seconds. `inf` is a linear running
 * mean over every frame since the last reset — the one to use for measuring a
 * room with pink noise, where the answer should stop moving.
 */
export const AVERAGES = {
  fast: 0.125,
  slow: 1,
  long: 4,
  inf: Infinity,
} as const;

export type AverageName = keyof typeof AVERAGES;

export type ViewMode = 'rta' | 'spectrograph' | 'split';

/** Which channel of the source feeds the analyser. The meter always shows all. */
export type AnalysisChannel = 'left' | 'right' | 'sum';

export interface Settings {
  fraction: Fraction;
  fftSize: FftSize;
  window: WindowName;
  /** Frame advance as a fraction of the transform: 0.25 = 75% overlap. */
  hopFraction: 0.25 | 0.5 | 1;
  averaging: AverageName;
  peakHold: boolean;
  view: ViewMode;
  channel: AnalysisChannel;
  /** dB range of the RTA graph. */
  dbTop: number;
  dbBottom: number;
  /** Added to every displayed level. Set it so a known SPL reads correctly. */
  calibrationDb: number;
}

export const DEFAULT_SETTINGS: Settings = {
  fraction: '1/12',
  fftSize: 16384,
  window: 'hann',
  hopFraction: 0.5,
  averaging: 'slow',
  peakHold: false,
  view: 'rta',
  channel: 'sum',
  dbTop: 0,
  dbBottom: -90,
  calibrationDb: 0,
};

/** Peak and RMS for one channel, in dBFS, as measured over every sample. */
export interface ChannelLevel {
  peak: number;
  rms: number;
}

export type SourceKind = 'device' | 'display' | 'test' | 'none';

export interface SourceInfo {
  kind: SourceKind;
  label: string;
  deviceId?: string;
  channels: number;
  sampleRate: number;
}
