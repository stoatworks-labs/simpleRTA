import { useEffect, useRef } from 'react';
import { SPECTRUM_SLOTS, type RtaEngine } from '../lib/analyser';
import type { BandPlan } from '../lib/bands';
import type { Settings } from '../types';
import { GRID_FREQS, LABEL_FREQS, freqLabel, makeFreqScale, rampColor, surface } from '../lib/plot';

const PAD = { left: 38, right: 8, top: 10, bottom: 20 };

/**
 * How much time the waterfall should span, and the row counts that bound it.
 *
 * One row is one transform, so a fixed row count would make the depth swing
 * with the settings — three seconds at 2048 with 75% overlap, eleven minutes at
 * 65536 with none. Choosing the rows from the hop instead keeps the axis at
 * roughly half a minute wherever the controls are, and the limits stop a very
 * fast or very slow hop from producing a useless one.
 */
const TARGET_SECONDS = 30;
const MIN_ROWS = 64;
const MAX_ROWS = 1024;

function rowsForHop(hopSeconds: number): number {
  if (!(hopSeconds > 0)) return 256;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(TARGET_SECONDS / hopSeconds)));
}

/**
 * Waterfall of the same band powers the RTA draws, scrolling downwards.
 *
 * The x axis is band index, and because the bands are geometrically spaced,
 * band index *is* log frequency — so an offscreen image one pixel per band wide
 * scales straight onto the plot and lines up with the RTA bars above it,
 * without resampling anything.
 *
 * History is kept as pixels rather than numbers: each new row is written at the
 * top of the offscreen canvas after shifting the existing image down by one.
 * That costs one blit per transform instead of redrawing the whole surface
 * every display frame.
 */
export function Spectrograph({ engine, settings }: { engine: RtaEngine; settings: Settings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const off = document.createElement('canvas');
    let offCtx: CanvasRenderingContext2D | null = null;
    let rowData: ImageData | null = null;
    let plan: BandPlan | null = null;
    let rows = 256;
    let lastSeq = -1;
    let raf = 0;
    const rgb = { r: 0, g: 0, b: 0 };

    // Changing the resolution changes the image width, and changing the hop
    // changes its height; either way the history it held no longer describes
    // what the axes now claim, so it is cleared rather than rescaled.
    const ensure = (p: BandPlan, wantRows: number) => {
      if (plan === p && rows === wantRows && offCtx) return;
      plan = p;
      rows = wantRows;
      off.width = Math.max(1, p.bands.length);
      off.height = rows;
      offCtx = off.getContext('2d');
      if (!offCtx) return;
      offCtx.fillStyle = '#08090b';
      offCtx.fillRect(0, 0, off.width, off.height);
      rowData = offCtx.createImageData(off.width, 1);
      lastSeq = -1;
    };

    const pushRow = (bandsDb: Float32Array, top: number, bottom: number) => {
      if (!offCtx || !rowData) return;
      // Scroll down by one row. Drawing a canvas onto itself is defined to read
      // from a snapshot, so the overlap is safe.
      offCtx.drawImage(off, 0, 0, off.width, rows - 1, 0, 1, off.width, rows - 1);

      const d = rowData.data;
      const range = top - bottom;
      for (let i = 0; i < off.width; i++) {
        rampColor((bandsDb[i] - bottom) / range, rgb);
        const o = i * 4;
        d[o] = rgb.r;
        d[o + 1] = rgb.g;
        d[o + 2] = rgb.b;
        d[o + 3] = 255;
      }
      offCtx.putImageData(rowData, 0, 0);
    };

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = surface(canvas);
      if (!s) return;
      const { ctx, w, h } = s;
      const cfg = settingsRef.current;
      const st = engine.state;

      const hopSeconds = (cfg.fftSize * cfg.hopFraction) / engine.info.sampleRate;
      ensure(st.plan, rowsForHop(hopSeconds));
      if (!offCtx) return;

      const top = cfg.dbTop + cfg.calibrationDb;
      const bottom = cfg.dbBottom + cfg.calibrationDb;

      // Catch up on every transform since the last display frame. Transforms
      // can outrun a 60 Hz screen, and drawing the newest one twice instead of
      // the two that actually happened would smear the waterfall in time.
      // Start no further back than the engine still holds — after a spell in a
      // background tab the rest is gone, and walking sequence numbers that
      // return nothing would be a long loop to no effect.
      if (lastSeq < 0) lastSeq = st.seq - 1;
      for (let seq = Math.max(lastSeq, st.seq - SPECTRUM_SLOTS); seq < st.seq; seq++) {
        const row = engine.spectrumAt(seq);
        if (row) pushRow(row, top, bottom);
      }
      lastSeq = st.seq;

      const x0 = PAD.left;
      const x1 = w - PAD.right;
      const y0 = PAD.top;
      const y1 = h - PAD.bottom;
      ctx.clearRect(0, 0, w, h);
      if (x1 <= x0 || y1 <= y0) return;

      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, off.width, rows, x0, y0, x1 - x0, y1 - y0);

      const bands = st.plan.bands;
      if (bands.length === 0) return;
      const fx = makeFreqScale(bands[0].flo, bands[bands.length - 1].fhi, x0, x1);

      ctx.strokeStyle = 'rgba(231, 232, 234, 0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of GRID_FREQS) {
        if (!LABEL_FREQS.has(f) || f < fx.fMin || f > fx.fMax) continue;
        const x = Math.round(fx.toX(f)) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      ctx.stroke();

      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillStyle = '#5b616b';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const f of GRID_FREQS) {
        if (!LABEL_FREQS.has(f) || f < fx.fMin || f > fx.fMax) continue;
        ctx.fillText(freqLabel(f), fx.toX(f), y1 + 5);
      }

      // Time axis. Held near TARGET_SECONDS by the row count, but the limits
      // bite at the extremes of the transform settings, so label what it is.
      const span = rows * hopSeconds;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const t = (span * i) / ticks;
        const y = y0 + ((y1 - y0) * i) / ticks;
        ctx.fillText(i === 0 ? 'now' : `−${t < 10 ? t.toFixed(1) : Math.round(t)}s`, x0 - 5, y);
      }

      ctx.strokeStyle = '#262a31';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return <canvas ref={canvasRef} />;
}
