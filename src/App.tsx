import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RtaEngine } from './lib/analyser';
import { RtaGraph } from './components/RtaGraph';
import { Spectrograph } from './components/Spectrograph';
import { LevelMeter } from './components/LevelMeter';
import { Controls } from './components/Controls';
import { settingsOf, useSettings } from './store';

const engine = new RtaEngine();

/** Re-render on the engine's structural changes (source attached, plan rebuilt). */
function useEngineRevision(): number {
  const rev = useRef(0);
  return useSyncExternalStore(
    useCallback((cb) => engine.subscribe(() => { rev.current++; cb(); }), []),
    () => rev.current,
  );
}

export default function App() {
  useEngineRevision();
  const store = useSettings();
  const settings = settingsOf(store);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Settings are compared inside the engine, so pushing them every render is
  // cheaper than working out here whether anything structural moved.
  engine.applySettings(settings);

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await RtaEngine.listInputs());
    } catch {
      /* enumeration is best-effort — a source can still be started */
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await refreshDevices();
      } catch (e) {
        const err = e as Error;
        setError(
          err.name === 'NotAllowedError'
            ? 'Permission denied. The browser needs access to the audio source — check the address-bar permission prompt and try again.'
            : err.name === 'NotFoundError'
              ? 'No matching audio input. Check the device is connected, then reload.'
              : err.message || String(e),
        );
      } finally {
        setBusy(false);
      }
    },
    [refreshDevices],
  );

  const live = engine.running;
  const info = engine.info;
  const view = settings.view;

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <h1>
            simple<em>RTA</em>
          </h1>
          {/* From the build, not typed here: a hand-written version is one more
              thing to forget at release time. Same source as the About dialog. */}
          <span className="ver">{__APP_VERSION__}</span>
        </div>

        <select
          value={info.deviceId ?? ''}
          disabled={busy}
          onChange={(e) => void run(() => engine.startDevice(e.target.value || undefined))}
          title="Audio input"
        >
          <option value="">Default input</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Input ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>

        <button className="btn" disabled={busy} onClick={() => void run(() => engine.startDisplay())}>
          Capture tab audio
        </button>

        <button
          className="btn"
          disabled={busy}
          title="Analyse pink noise generated in this page. Nothing is played out — it is a check that the analyser itself reads flat."
          onClick={() => void run(() => engine.startTestSignal())}
        >
          Pink noise
        </button>

        {live ? (
          <button className="btn danger" onClick={() => void run(() => engine.stop())}>
            Stop
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void run(() => engine.startDevice())}
          >
            Start
          </button>
        )}

        <div className="spacer" />

        <div className="srcinfo">
          <span className={`dot${live ? ' live' : ''}`} />
          <span className="name">{info.label}</span>
          {live && (
            <span>
              {(info.sampleRate / 1000).toFixed(1)} kHz · {info.channels === 1 ? 'mono' : 'stereo'}
            </span>
          )}
        </div>

        {/* Opens the shared About dialog — see public/about.js, which delegates
            this attribute from the document, so nothing needs importing here. */}
        <button type="button" className="btn" data-stoatworks-about>
          About
        </button>
      </div>

      <div className="main">
        <div className="plots">
          {(view === 'rta' || view === 'split') && (
            <div className="plot">
              <RtaGraph engine={engine} settings={settings} />
              <div className="plot-tag">RTA · {settings.fraction} octave</div>
            </div>
          )}
          {(view === 'spectrograph' || view === 'split') && (
            <div className="plot">
              <Spectrograph engine={engine} settings={settings} />
              <div className="plot-tag">Spectrograph</div>
            </div>
          )}

          {!live && (
            <div className="overlay">
              <div className="card">
                <h2>Pick a source</h2>
                {error && <div className="err">{error}</div>}
                <p>
                  <b>An input</b> — a microphone, a measurement mic on an interface, or a return
                  from a console. The browser's echo cancellation, noise suppression and automatic
                  gain are all switched off, so what you see is the signal and not the voice
                  pipeline.
                </p>
                <p>
                  <b>Tab audio</b> — captures what another browser tab is playing. Choose a tab in
                  the picker and tick "Share tab audio"; whole-window and full-screen shares carry
                  no audio on most platforms. Chrome and Edge only.
                </p>
                <p>
                  <b>Pink noise</b> — generated in this page and analysed without going anywhere
                  near the speakers. Pink noise is flat on a constant-percentage-bandwidth
                  display, so this is the check that the analyser reads level before you trust
                  what it says about a room.
                </p>
                <p>
                  Everything runs in this page. No audio leaves the browser, and there is no
                  server to send it to.
                </p>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => void run(() => engine.startDevice())}
                  >
                    Use an audio input
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void run(() => engine.startDisplay())}
                  >
                    Capture tab audio
                  </button>
                  <button
                    className="btn"
                    disabled={busy}
                    onClick={() => void run(() => engine.startTestSignal())}
                  >
                    Pink noise test signal
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <LevelMeter engine={engine} settings={settings} />
      </div>

      <Controls engine={engine} settings={settings} />
    </div>
  );
}
