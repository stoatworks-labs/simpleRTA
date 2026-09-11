import { useEffect, useState } from 'react';
import type { RtaEngine } from '../lib/analyser';
import { formatPeakHz } from '../lib/bands';

/** The readout is meaningless below this — an unfed analyser reads −140. */
const FLOOR_DB = -120;

/**
 * The strip across the top of the RTA: the frequency of the tallest band, and
 * its level.
 *
 * Read from the engine on a timer rather than on every transform, so the
 * digits change at a rate a person can read; the bars underneath still move
 * at the display rate. What it names is the peak of the *averaged* spectrum
 * the bars are drawn from, so it settles at the rate the display does and
 * never points at a bar the graph is not showing as tallest.
 */
export function PeakBanner({ engine, tag }: { engine: RtaEngine; tag: string }) {
  const [peak, setPeak] = useState<{ hz: number; db: number } | null>(null);

  useEffect(() => {
    const read = () => {
      const st = engine.state;
      const pb = st.peakBand;
      const db = pb ? st.bandsDb[pb.index] : -Infinity;
      setPeak(pb && db > FLOOR_DB ? { hz: pb.hz, db } : null);
    };
    read();
    const id = setInterval(read, 100);
    return () => clearInterval(id);
  }, [engine]);

  return (
    <div className="peakbar" title="Tallest band of the RTA, and its level">
      <span className="k">Peak</span>
      <span className="hz">{peak ? formatPeakHz(peak.hz) : '—'}</span>
      <span className="db">{peak ? `${peak.db.toFixed(1)} dB` : ''}</span>
      <span className="tag">{tag}</span>
    </div>
  );
}
