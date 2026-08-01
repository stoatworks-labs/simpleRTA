import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_SETTINGS, type Settings } from './types';

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

/**
 * Settings live here and nowhere else. Everything that draws reads the engine's
 * buffers directly on the display clock; this store carries only the handful of
 * values a human changes, so a re-render on change costs nothing.
 */
export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_SETTINGS }),
    }),
    {
      name: 'simplerta.settings',
      version: 2,
      // v1 carried a `showWeighting` flag that never had a control; the A- and
      // C-weighted broadband levels are simply always shown. Rebuild the stored
      // object from the current keys so a retired one cannot linger.
      migrate: (persisted) => {
        const old = (persisted ?? {}) as Partial<Settings>;
        const next = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
          if (old[key] !== undefined) (next as Record<string, unknown>)[key] = old[key];
        }
        return next;
      },
      // Peak hold is a measurement in progress, not a preference — a reload
      // should not come back holding peaks from a previous session.
      partialize: (s) => {
        const { set: _set, reset: _reset, peakHold: _peak, ...rest } = s;
        return rest;
      },
    },
  ),
);

export function settingsOf(s: SettingsStore): Settings {
  const { set: _set, reset: _reset, ...rest } = s;
  return rest;
}
