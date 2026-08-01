import { useEffect, useRef } from 'react';
import type { RtaEngine } from '../lib/analyser';
import type { Settings } from '../types';
import {
  GRID_FREQS,
  LABEL_FREQS,
  dbStep,
  freqLabel,
  levelGradient,
  makeFreqScale,
  surface,
} from '../lib/plot';

const PAD = { left: 38, right: 8, top: 10, bottom: 20 };

/**
 * The RTA itself: one bar per fractional-octave band on a log frequency axis.
 *
 * Draws on the display clock straight out of the engine's state rather than
 * from React props, so the transform rate and the frame rate stay independent.
 */
export function RtaGraph({ engine, settings }: { engine: RtaEngine; settings: Settings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const canvas = canvasRef.current!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = surface(canvas);
      if (!s) return;
      const { ctx, w, h } = s;
      const cfg = settingsRef.current;
      const st = engine.state;
      const plan = st.plan;
      const bands = plan.bands;

      ctx.clearRect(0, 0, w, h);
      if (bands.length === 0) return;

      const x0 = PAD.left;
      const x1 = w - PAD.right;
      const y0 = PAD.top;
      const y1 = h - PAD.bottom;
      if (x1 <= x0 || y1 <= y0) return;

      const fMin = bands[0].flo;
      const fMax = bands[bands.length - 1].fhi;
      const fx = makeFreqScale(fMin, fMax, x0, x1);
      const top = cfg.dbTop + cfg.calibrationDb;
      const bottom = cfg.dbBottom + cfg.calibrationDb;
      const dbToY = (db: number) =>
        y1 - ((Math.min(top, Math.max(bottom, db)) - bottom) / (top - bottom)) * (y1 - y0);

      // --- region the transform cannot actually resolve at this resolution ---
      if (plan.resolvedAboveHz > fMin) {
        const xr = Math.min(x1, fx.toX(Math.min(plan.resolvedAboveHz, fMax)));
        ctx.fillStyle = 'rgba(255, 176, 46, 0.055)';
        ctx.fillRect(x0, y0, xr - x0, y1 - y0);
        ctx.strokeStyle = 'rgba(255, 176, 46, 0.35)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(xr) + 0.5, y0);
        ctx.lineTo(Math.round(xr) + 0.5, y1);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // --- grid ---
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.strokeStyle = '#1c2027';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of GRID_FREQS) {
        if (f < fMin || f > fMax) continue;
        const x = Math.round(fx.toX(f)) + 0.5;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
      const step = dbStep(top - bottom);
      for (let db = Math.ceil(bottom / step) * step; db <= top; db += step) {
        const y = Math.round(dbToY(db)) + 0.5;
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();

      // --- bars ---
      const grad = levelGradient(ctx, y0, y1, top, bottom);
      ctx.fillStyle = grad;
      const baseY = y1;
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const bx0 = fx.toX(b.flo);
        const bx1 = fx.toX(b.fhi);
        const bw = bx1 - bx0;
        const gap = bw > 3 ? 1 : 0;
        const y = dbToY(st.bandsDb[i]);
        if (y >= baseY - 0.5) continue;
        ctx.fillRect(bx0 + gap / 2, y, Math.max(0.75, bw - gap), baseY - y);
      }

      // --- peak hold ---
      if (cfg.peakHold) {
        ctx.fillStyle = '#e7e8ea';
        for (let i = 0; i < bands.length; i++) {
          const pd = st.peakDb[i];
          if (pd <= bottom) continue;
          const b = bands[i];
          const bx0 = fx.toX(b.flo);
          const bw = fx.toX(b.fhi) - bx0;
          ctx.fillRect(bx0, dbToY(pd) - 1, Math.max(1, bw), 1.5);
        }
      }

      // --- axes ---
      ctx.fillStyle = '#5b616b';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let db = Math.ceil(bottom / step) * step; db <= top; db += step) {
        ctx.fillText(String(Math.round(db)), x0 - 5, dbToY(db));
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const f of GRID_FREQS) {
        if (f < fMin || f > fMax || !LABEL_FREQS.has(f)) continue;
        ctx.fillText(freqLabel(f), fx.toX(f), y1 + 5);
      }

      ctx.strokeStyle = '#262a31';
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);

      // --- cursor readout ---
      const cur = cursor.current;
      if (cur && cur.x >= x0 && cur.x <= x1 && cur.y >= y0 && cur.y <= y1) {
        const f = fx.toF(cur.x);
        let idx = 0;
        let best = Infinity;
        for (let i = 0; i < bands.length; i++) {
          const d = Math.abs(Math.log2(bands[i].fc / f));
          if (d < best) { best = d; idx = i; }
        }
        const b = bands[idx];
        const cx = Math.round(fx.toX(b.fc)) + 0.5;
        ctx.strokeStyle = 'rgba(43, 143, 255, 0.55)';
        ctx.beginPath();
        ctx.moveTo(cx, y0);
        ctx.lineTo(cx, y1);
        ctx.stroke();

        const level = st.bandsDb[idx];
        const text = `${b.label} Hz   ${level > bottom ? level.toFixed(1) : '−∞'} dB`;
        ctx.font = '11px ui-monospace, Menlo, monospace';
        const tw = ctx.measureText(text).width;
        const bx = Math.min(x1 - tw - 12, Math.max(x0 + 2, cx + 8));
        ctx.fillStyle = 'rgba(18, 19, 23, 0.92)';
        ctx.fillRect(bx, y0 + 4, tw + 10, 20);
        ctx.strokeStyle = '#262a31';
        ctx.strokeRect(bx + 0.5, y0 + 4.5, tw + 9, 19);
        ctx.fillStyle = '#e7e8ea';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 5, y0 + 14.5);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <canvas
      ref={canvasRef}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        cursor.current = { x: e.clientX - r.left, y: e.clientY - r.top };
      }}
      onMouseLeave={() => {
        cursor.current = null;
      }}
    />
  );
}
