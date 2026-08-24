# AGENTS.md — bringing an LLM up to speed on simpleRTA

Orientation for an AI assistant (or a new human) picking this project up cold.
`CLAUDE.md` holds the short command reference; this file explains the model and
the traps.

---

## 1. What this is

A **real-time audio analyser** that runs entirely in a browser tab. React +
TypeScript + Vite, built to a static `dist/` and served by a Cloudflare Worker
with static assets. No backend, no accounts, no telemetry — the audio is
analysed on the page and never leaves it.

It shows, from one audio source at a time:

- a **fractional-octave RTA**, 1/3 through 1/48 octave
- a scrolling **spectrograph** sharing the RTA's frequency axis
- a full-height **peak/RMS bargraph meter** with peak hold and a latching clip
  indicator

Sources are a microphone or line input, another browser tab's audio, or pink
noise generated in the page.

## 2. Layout

```
public/
  rta-worklet.js        THE CAPTURE WORKLET. Plain JS, loaded by URL, not bundled.
  _headers              CSP + Permissions-Policy. Copied into dist/ by Vite.
src/
  types.ts              domain types and the settings shape. Read this first.
  store.ts              zustand settings store, persisted to localStorage
  lib/
    fft.ts              radix-2 FFT + the power-spectrum normalisation
    windows.ts          Hann/Hamming/Blackman-Harris/flat-top/rect, S1, S2, ENBW
    bands.ts            THE ENGINE'S CORE. Band table and density integration.
    analyser.ts         audio graph, ring buffer, transform loop, averaging
    weighting.ts        A- and C-weighting
    plot.ts             shared canvas helpers — axes, colour ramps
  components/           RtaGraph, Spectrograph, LevelMeter, Controls
  App.tsx               wiring and the source picker
```

**`bands.ts` and `fft.ts` are the measurement.** Everything else presents it.

## 3. The convention every number obeys

A **full-scale sine reads 0 dBFS**.

That falls out of two decisions in `fft.ts` and `bands.ts`:

```
power[k] = 2·|X_k|² / (N · S2)        S2 = Σw[n]²
level    = 10·log10(P) + 10·log10(2)
```

The `N` is the DFT's own gain — leave it out and every level scales with the
transform size. Normalising by `S2` (the sum of *squares*) rather than `S1` is
what makes the result correct for **noise**, which is what summing a spectrum
into an octave band assumes; `S1` would be right for isolated tones and wrong
here. The `+3.01 dB` turns "RMS relative to full scale" into the peak-referenced
dBFS a studio meter shows, since a ±1.0 sine has a mean square of 0.5.

`fft.test.ts` pins this at four transform sizes and through all five windows. If
you change the normalisation, that file is the one that matters.

## 4. The trap: bands are integrated, not bucketed

At 1/48 octave most bands are **narrower than the FFT bin spacing**. At 48 kHz
with a 16384-point transform the bins are 2.93 Hz apart, while a 1/48-octave
band at 100 Hz is 1.44 Hz wide.

The obvious implementation is two paths — sum the bins inside the band, and
interpolate when there are none. **That double-counts.** In the transition
region a bin falls inside one band while its neighbours, having no bin of their
own, interpolate from that same bin. Measured on white noise at 1/48, the
overlap read **1.3 dB high** across the bottom three octaves, and the RTA's
broadband total drifted with the resolution setting.

`integrateBands` instead treats the spectrum as a piecewise-linear **density**
sampled at the bin centres and integrates it between the band edges. Adjacent
bands then consume adjacent, non-overlapping stretches of spectrum:

- a wide band reduces to the sum of the bins it covers
- a narrow band gets a fair share of the bin it sits in
- power is conserved exactly however the bands fall against the bins

`chain.test.ts` asserts the band total matches the spectrum it came from to
within 0.1 dB at every resolution. That test is the guard on this.

### What it still cannot do

Integration does not invent resolution. Below `BandPlan.resolvedAboveHz` — where
a band is narrower than the transform's own filter, `ENBW · binHz` — neighbouring
bands report shares of one measurement rather than independent ones. The RTA
shades that region and the controls state the frequency. Do not remove the
shading to make the display look cleaner; it is the honest part.

## 5. Other things that will bite

### Bands are centred on 1 kHz at every resolution

IEC 61260 puts 1 kHz at a band *edge* for even denominators (1/6, 1/12, 1/24,
1/48) and at a centre only for odd ones. simpleRTA centres on 1 kHz throughout,
so the band centres nest as the resolution changes — switch 1/6 to 1/48 and
every 1/6 centre is still there. The 1/3-octave set matches IEC either way.

### Windows are periodic, not symmetric

Generated with denominator `N`, not `N-1`, because the signal is assumed to
continue past the frame. The published ENBW figures in `WINDOWS` assume this
form, and `windows.test.ts` checks the generated coefficients reproduce them.

### The engine lives outside React

`RtaEngine` is a plain class with a module-level instance. Components read its
buffers inside `requestAnimationFrame`; spectra never pass through React state.
Only the settings store and a coarse "structural change" subscription re-render.
Pushing spectra through React at 20-90 frames a second would spend a core on
reconciliation.

### `requestAnimationFrame` stops in a background tab, the audio does not

So the spectrograph freezes while the tab is hidden even though transforms keep
running. `SPECTRUM_SLOTS` (256 frames, ~45 s at default settings) is how much it
can catch up on afterwards; past that, history is genuinely lost. The catch-up
loop is clamped to that, or it would walk tens of thousands of dead sequence
numbers after a long spell in the background.

### Capture constraints must all be off

`echoCancellation`, `noiseSuppression` and `autoGainControl` are gain- and
spectrum-shaping filters. Leave any of them on and the analyser measures the
browser's voice pipeline instead of the signal.

### `getDisplayMedia` needs `video: true`

Chrome will not offer the audio-bearing picker entries without a video track
requested. We ask for video and stop the track immediately. Window and
full-screen shares carry no audio on most platforms — only a tab does.

### The worklet output goes to a zero gain, then the destination

A worklet with no path to the destination is not guaranteed to be pulled. The
silent sink keeps the graph alive without putting captured audio back out of the
speakers, which on a live microphone would be a feedback loop.

### The page is taller than the viewport, on purpose

`.app` is `100dvh`; the shared support footer sits below the fold. That is why
`body` is not `overflow: hidden` — the footer has to be reachable. Nothing
inside the app scrolls.

## 6. How to verify a change

Use the **pink noise** source, not a microphone. Pink noise is flat on a
constant-percentage-bandwidth display, so a correct RTA draws a level line from
20 Hz to 20 kHz at every resolution:

- the trace should be **flat**, and **smooth through the shaded region** — a
  step at the `resolvedAboveHz` boundary is the double-counting bug returning
- the broadband **Z** readout should barely move as the resolution changes
- switching 1/12 to 1/48 should drop each band by ~6 dB (a quarter of the
  bandwidth), while Z stays put

A microphone tells you about the room. Pink noise tells you about the analyser.

## 7. Deliberately not here

- **No transfer function / dual-channel measurement.** No delay finder, no
  coherence. That is a different instrument.
- **No calibrated SPL.** There is a dB offset field so a known reference can be
  dialled in, but nothing verifies it and no microphone correction curve is
  applied. Levels are dBFS unless the user has calibrated them, and the app does
  not claim otherwise.
- **No recording or export.** Nothing is stored but the settings.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
