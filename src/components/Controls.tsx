import type { RtaEngine } from '../lib/analyser';
import { WINDOWS, type WindowName } from '../lib/windows';
import { formatHz } from '../lib/bands';
import {
  FFT_SIZES,
  FRACTION_LIST,
  type AnalysisChannel,
  type AverageName,
  type FftSize,
  type Fraction,
  type Settings,
  type ViewMode,
} from '../types';
import { useSettings } from '../store';

function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={o.v === value ? 'on' : ''}
          title={o.title}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const AVERAGE_OPTIONS: { v: AverageName; label: string; title: string }[] = [
  { v: 'fast', label: 'Fast', title: '125 ms exponential average' },
  { v: 'slow', label: 'Slow', title: '1 s exponential average' },
  { v: 'long', label: 'Long', title: '4 s exponential average' },
  { v: 'inf', label: '∞', title: 'Linear average over every frame since reset — for noise measurements' },
];

export function Controls({ engine, settings }: { engine: RtaEngine; settings: Settings }) {
  const set = useSettings((s) => s.set);
  const plan = engine.state.plan;
  const win = WINDOWS.find((w) => w.name === settings.window)!;

  const transformMs = (settings.fftSize / engine.info.sampleRate) * 1000;
  const hopMs = transformMs * settings.hopFraction;
  const underResolved = plan.resolvedAboveHz > (plan.bands[0]?.flo ?? 0);

  return (
    <div className="controls">
      <div className="ctl">
        <label>Resolution</label>
        <Seg<Fraction>
          value={settings.fraction}
          options={FRACTION_LIST.map((f) => ({ v: f, label: f, title: `${f} octave bands` }))}
          onChange={(fraction) => set({ fraction })}
        />
      </div>

      <div className="ctl">
        <label>FFT size</label>
        <select
          value={settings.fftSize}
          onChange={(e) => set({ fftSize: Number(e.target.value) as FftSize })}
        >
          {FFT_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} · {((n / engine.info.sampleRate) * 1000).toFixed(0)} ms
            </option>
          ))}
        </select>
      </div>

      <div className="ctl">
        <label>Window</label>
        <select
          value={settings.window}
          onChange={(e) => set({ window: e.target.value as WindowName })}
          title={win.blurb}
        >
          {WINDOWS.map((w) => (
            <option key={w.name} value={w.name} title={w.blurb}>
              {w.label}
            </option>
          ))}
        </select>
      </div>

      <div className="ctl">
        <label>Overlap</label>
        <Seg<number>
          value={settings.hopFraction}
          options={[
            { v: 0.25, label: '75%', title: 'Hop a quarter of the transform' },
            { v: 0.5, label: '50%', title: 'Hop half the transform' },
            { v: 1, label: 'None', title: 'Consecutive non-overlapping frames' },
          ]}
          onChange={(v) => set({ hopFraction: v as Settings['hopFraction'] })}
        />
      </div>

      <div className="ctl">
        <label>Averaging</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <Seg<AverageName>
            value={settings.averaging}
            options={AVERAGE_OPTIONS}
            onChange={(averaging) => set({ averaging })}
          />
          <button className="btn" onClick={() => engine.resetAveraging()} title="Restart the average">
            Reset
          </button>
        </div>
      </div>

      <div className="ctl">
        <label>Peak hold</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={`btn${settings.peakHold ? ' on' : ''}`}
            onClick={() => set({ peakHold: !settings.peakHold })}
          >
            {settings.peakHold ? 'Holding' : 'Hold'}
          </button>
          <button
            className="btn"
            disabled={!settings.peakHold}
            onClick={() => engine.resetPeakHold()}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="ctl">
        <label>View</label>
        <Seg<ViewMode>
          value={settings.view}
          options={[
            { v: 'rta', label: 'RTA' },
            { v: 'spectrograph', label: 'Spectro' },
            { v: 'split', label: 'Split' },
          ]}
          onChange={(view) => set({ view })}
        />
      </div>

      <div className="ctl">
        <label>Channel</label>
        <Seg<AnalysisChannel>
          value={settings.channel}
          options={[
            { v: 'left', label: 'L' },
            { v: 'right', label: 'R' },
            { v: 'sum', label: 'L+R' },
          ]}
          onChange={(channel) => set({ channel })}
        />
      </div>

      <div className="ctl">
        <label>Range dB</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="number"
            step={5}
            value={settings.dbTop}
            onChange={(e) => set({ dbTop: Number(e.target.value) })}
            title="Top of the scale"
          />
          <input
            type="number"
            step={5}
            value={settings.dbBottom}
            onChange={(e) => set({ dbBottom: Number(e.target.value) })}
            title="Bottom of the scale"
          />
        </div>
      </div>

      <div className="ctl">
        <label>Offset dB</label>
        <input
          type="number"
          step={0.5}
          value={settings.calibrationDb}
          onChange={(e) => set({ calibrationDb: Number(e.target.value) })}
          title="Added to every displayed level. Set it so a known reference reads correctly — then the scale is SPL rather than dBFS."
        />
      </div>

      <div className="spacer" />

      <div className="hint">
        <div>
          bin <b>{plan.binHz.toFixed(2)} Hz</b> · frame <b>{transformMs.toFixed(0)} ms</b> · hop{' '}
          <b>{hopMs.toFixed(0)} ms</b> · ENBW <b>{win.enbw.toFixed(2)} bins</b>
        </div>
        <div>
          {underResolved ? (
            <>
              bands measured above <b>{formatHz(plan.resolvedAboveHz)} Hz</b> — below that the
              shaded region is interpolated
            </>
          ) : (
            <>every band is at least one bin wide</>
          )}
        </div>
      </div>
    </div>
  );
}
