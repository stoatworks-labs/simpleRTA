import { useEffect, useRef, useState } from 'react';
import type { RtaEngine } from '../lib/analyser';
import type { Settings } from '../types';
import { surface } from '../lib/plot';

/** Height of the meter window, in dB below the top of the scale. */
const SPAN_DB = 72;

const SEG_H = 5;
const SEG_GAP = 1;

/** Peak fall-back rate, dB per second. Roughly IEC PPM. */
const PEAK_DECAY = 26;
/** How long the peak-hold marker sits before it starts falling. */
const HOLD_SECONDS = 1.6;

const CHANNEL_NAMES = ['L', 'R'];

/** Levels below this are silence as far as the readout is concerned. */
const FLOOR_DB = -120;

function fmtBroadband(v: number): string {
  return Number.isFinite(v) && v > FLOOR_DB ? v.toFixed(1) : '−∞';
}

/**
 * Full-height segmented bargraph, in the style of the atem-overseer meters —
 * same 24-step look and the same green / amber / red ramp, but running the
 * whole height of the window and with a dB scale, peak-hold markers and a
 * latching clip indicator, because here the meter is the instrument rather
 * than an overlay on a video tile.
 *
 * Peak and RMS come from the worklet, which sees every sample; nothing is
 * sampled at frame rate, so a transient between two frames still registers.
 */
export function LevelMeter({ engine, settings }: { engine: RtaEngine; settings: Settings }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [readout, setReadout] = useState<{
    peak: number[];
    rms: number[];
    clip: boolean[];
    broadband: [number, number, number];
  }>({
    peak: [],
    rms: [],
    clip: [],
    broadband: [-Infinity, -Infinity, -Infinity],
  });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const rmsDisp: number[] = [];
    const peakDisp: number[] = [];
    const holdDb: number[] = [];
    const holdUntil: number[] = [];
    let clip: boolean[] = [];
    let last = performance.now();
    let sinceReadout = 0;
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const s = surface(canvas);
      if (!s) return;
      const { ctx, w, h } = s;
      const cfg = settingsRef.current;

      const { levels, clipped } = engine.consumeLevels();
      clip = clipped;
      const n = Math.max(1, levels.length);

      const top = cfg.dbTop + cfg.calibrationDb;
      const bottom = top - SPAN_DB;
      // Inset top and bottom: the scale's topmost label is centred on the very
      // top of the range, and the channel letters live under the bars.
      const yTop = 7;
      const yBot = h - 14;
      const barH = Math.max(1, yBot - yTop);
      const toY = (db: number) =>
        yBot - ((Math.min(top, Math.max(bottom, db)) - bottom) / SPAN_DB) * barH;

      // --- ballistics ---
      for (let c = 0; c < n; c++) {
        const lv = levels[c] ?? { peak: bottom, rms: bottom };
        if (rmsDisp[c] === undefined) {
          rmsDisp[c] = bottom;
          peakDisp[c] = bottom;
          holdDb[c] = bottom;
          holdUntil[c] = 0;
        }
        // RMS is already averaged over the delivery block; a light smoothing
        // stops the bar shimmering without making it lag.
        rmsDisp[c] += (Math.max(bottom, lv.rms) - rmsDisp[c]) * Math.min(1, dt * 18);

        const p = Math.max(bottom, lv.peak);
        peakDisp[c] = p > peakDisp[c] ? p : Math.max(bottom, peakDisp[c] - PEAK_DECAY * dt);

        if (p >= holdDb[c]) {
          holdDb[c] = p;
          holdUntil[c] = now + HOLD_SECONDS * 1000;
        } else if (now > holdUntil[c]) {
          holdDb[c] = Math.max(bottom, holdDb[c] - PEAK_DECAY * 0.5 * dt);
        }
      }

      ctx.clearRect(0, 0, w, h);

      // --- scale ---
      const scaleW = 24;
      ctx.font = '9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = '#1c2027';
      ctx.beginPath();
      for (let db = Math.ceil(bottom / 6) * 6; db <= top; db += 6) {
        const y = Math.round(toY(db)) + 0.5;
        const major = (Math.round(db - top) / 12) % 1 === 0;
        ctx.moveTo(scaleW - (major ? 6 : 3), y);
        ctx.lineTo(scaleW, y);
        if (major) {
          ctx.fillStyle = '#5b616b';
          ctx.fillText(String(Math.round(db)), scaleW - 8, y);
        }
      }
      ctx.stroke();

      // --- bars ---
      const availW = w - scaleW - 6;
      const gap = 4;
      const barW = Math.min(26, Math.floor((availW - gap * (n - 1)) / n));
      const totalW = barW * n + gap * (n - 1);
      const bx0 = scaleW + 4 + Math.max(0, (availW - totalW) / 2);

      const steps = Math.max(8, Math.floor(barH / (SEG_H + SEG_GAP)));
      const segPitch = barH / steps;
      for (let c = 0; c < n; c++) {
        const x = bx0 + c * (barW + gap);

        ctx.fillStyle = '#101317';
        ctx.fillRect(x, yTop, barW, barH);

        const frac = (rmsDisp[c] - bottom) / SPAN_DB;
        for (let i = 0; i < steps; i++) {
          const sf = i / steps;
          if (sf > frac) break;
          const db = bottom + sf * SPAN_DB;
          const below = top - db;
          ctx.fillStyle = below < 3 ? '#ff3b30' : below < 12 ? '#ffd23f' : '#37d67a';
          ctx.fillRect(x, yBot - (i + 1) * segPitch, barW, segPitch - SEG_GAP);
        }

        // Instantaneous peak, sitting above the averaged body.
        if (peakDisp[c] > bottom) {
          const py = toY(peakDisp[c]);
          ctx.fillStyle = top - peakDisp[c] < 3 ? '#ff3b30' : 'rgba(231,232,234,0.55)';
          ctx.fillRect(x, py, barW, 2);
        }

        // Peak hold.
        if (holdDb[c] > bottom) {
          const hy = toY(holdDb[c]);
          ctx.fillStyle = top - holdDb[c] < 3 ? '#ff3b30' : '#e7e8ea';
          ctx.fillRect(x, Math.max(yTop, hy - 1), barW, 2);
        }

        ctx.fillStyle = '#5b616b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(CHANNEL_NAMES[c] ?? String(c + 1), x + barW / 2, h - 2);
      }

      // The numeric readout is React state, so it updates at a rate a human can
      // actually read rather than at 60 Hz.
      sinceReadout += dt;
      if (sinceReadout > 0.1) {
        sinceReadout = 0;
        const es = engine.state;
        setReadout({
          peak: peakDisp.slice(0, n).map((v) => v),
          rms: rmsDisp.slice(0, n).map((v) => v),
          clip: clip.slice(0, n),
          broadband: [es.broadbandDb, es.broadbandADb, es.broadbandCDb],
        });
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const anyClip = readout.clip.some(Boolean);
  const fmt = (v: number | undefined) =>
    v === undefined || v <= settings.dbTop + settings.calibrationDb - SPAN_DB
      ? '−∞'
      : v.toFixed(1);

  return (
    <div className="meterpane">
      <div className="mhead">
        <span>Level</span>
        <button
          className={`clip-btn${anyClip ? ' lit' : ''}`}
          onClick={() => engine.resetClip()}
          title="Latching clip indicator — click to reset"
        >
          CLIP
        </button>
      </div>
      <div className="mbody">
        <canvas ref={canvasRef} />
      </div>
      <div className="mfoot">
        <span />
        <span className="v">{CHANNEL_NAMES[0]}</span>
        <span className="v">{readout.peak.length > 1 ? CHANNEL_NAMES[1] : ''}</span>
        <span>pk</span>
        <span className="v">{fmt(readout.peak[0])}</span>
        <span className="v">{readout.peak.length > 1 ? fmt(readout.peak[1]) : ''}</span>
        <span>rms</span>
        <span className="v">{fmt(readout.rms[0])}</span>
        <span className="v">{readout.rms.length > 1 ? fmt(readout.rms[1]) : ''}</span>
      </div>

      {/*
        Broadband level of the analysed channel, summed back out of the bands
        the RTA is drawing — so it agrees with the graph rather than being a
        second, separately-derived number. Z is unweighted; A and C are the
        standard weightings, and are what a sound level meter would report.
      */}
      <div className="mfoot weights" title="Broadband level, summed from the displayed bands">
        <span>Z</span>
        <span className="v">{fmtBroadband(readout.broadband[0])}</span>
        <span>A</span>
        <span className="v">{fmtBroadband(readout.broadband[1])}</span>
        <span>C</span>
        <span className="v">{fmtBroadband(readout.broadband[2])}</span>
      </div>
    </div>
  );
}
