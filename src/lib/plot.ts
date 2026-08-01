/** Small shared helpers for the canvases. Kept out of the components so the
 *  RTA, the spectrograph and the meter cannot drift apart on their axes. */

export interface Surface {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  dpr: number;
}

/**
 * Size the backing store to the element's CSS size × devicePixelRatio and
 * return a context already scaled to CSS pixels. Resizing a canvas clears it,
 * so this only touches width/height when they are actually wrong.
 */
export function surface(canvas: HTMLCanvasElement): Surface | null {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

/** Logarithmic frequency axis. */
export function makeFreqScale(fMin: number, fMax: number, x0: number, x1: number) {
  const lo = Math.log10(fMin);
  const span = Math.log10(fMax) - lo;
  const width = x1 - x0;
  return {
    fMin,
    fMax,
    toX: (f: number) => x0 + ((Math.log10(f) - lo) / span) * width,
    toF: (x: number) => Math.pow(10, lo + ((x - x0) / width) * span),
  };
}

/** Grid lines for a log frequency axis: every 1-2-3…9 × decade. */
export const GRID_FREQS: number[] = (() => {
  const out: number[] = [];
  for (let decade = 1; decade <= 10000; decade *= 10) {
    for (let m = 1; m <= 9; m++) out.push(decade * m);
  }
  out.push(100000);
  return out;
})();

export const LABEL_FREQS = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);

export function freqLabel(f: number): string {
  if (f >= 1000) return `${f / 1000}k`;
  return `${f}`;
}

/**
 * Level colour, by headroom below the top of the scale.
 *
 * The same green / amber / red split the atem-overseer meters use, expressed in
 * dB below the ceiling rather than as a fraction of a bar so the RTA bars and
 * the level meter agree about what "hot" means.
 */
export function levelColor(db: number, top: number): string {
  const below = top - db;
  if (below < 3) return '#ff3b30';
  if (below < 12) return '#ffd23f';
  return '#37d67a';
}

/** Vertical green→amber→red gradient over a dB window, for bar fills. */
export function levelGradient(
  ctx: CanvasRenderingContext2D,
  yTop: number,
  yBottom: number,
  top: number,
  bottom: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(0, yTop, 0, yBottom);
  const stop = (db: number) => Math.min(1, Math.max(0, (top - db) / (top - bottom)));
  g.addColorStop(0, '#ff3b30');
  g.addColorStop(stop(top - 3), '#ff3b30');
  g.addColorStop(stop(top - 3.01), '#ffd23f');
  g.addColorStop(stop(top - 12), '#ffd23f');
  g.addColorStop(stop(top - 12.01), '#37d67a');
  g.addColorStop(1, '#37d67a');
  return g;
}

/**
 * Spectrograph colour ramp, dark → blue → accent → green → amber → red.
 * `t` is 0 at the bottom of the dB window and 1 at the top.
 */
const RAMP: [number, number, number, number][] = [
  [0.0, 8, 9, 11],
  [0.18, 16, 32, 62],
  [0.38, 43, 143, 255],
  [0.58, 55, 214, 122],
  [0.78, 255, 210, 63],
  [1.0, 255, 59, 48],
];

export function rampColor(t: number, out: { r: number; g: number; b: number }): void {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0] || i === RAMP.length - 1) {
      const [p0, r0, g0, b0] = RAMP[i - 1];
      const [p1, r1, g1, b1] = RAMP[i];
      const k = p1 === p0 ? 0 : (x - p0) / (p1 - p0);
      out.r = (r0 + (r1 - r0) * k) | 0;
      out.g = (g0 + (g1 - g0) * k) | 0;
      out.b = (b0 + (b1 - b0) * k) | 0;
      return;
    }
  }
}

/** dB grid step that keeps the horizontal lines readable at any zoom. */
export function dbStep(range: number): number {
  if (range <= 24) return 3;
  if (range <= 48) return 6;
  if (range <= 90) return 10;
  return 20;
}
