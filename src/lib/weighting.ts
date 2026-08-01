/** IEC 61672-1 A-weighting, in dB, at a frequency in Hz. */
export function aWeightDb(f: number): number {
  const f2 = f * f;
  const num = 12194 ** 2 * f2 * f2;
  const den =
    (f2 + 20.6 ** 2) *
    Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) *
    (f2 + 12194 ** 2);
  return 20 * Math.log10(num / den) + 2.0;
}

/** C-weighting, in dB. Included for the broadband readout. */
export function cWeightDb(f: number): number {
  const f2 = f * f;
  const num = 12194 ** 2 * f2;
  const den = (f2 + 20.6 ** 2) * (f2 + 12194 ** 2);
  return 20 * Math.log10(num / den) + 0.06;
}
