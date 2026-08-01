# simpleRTA

> **AI-assisted project.** This codebase was created with [Claude Code](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The analysis chain is verified numerically —
> 29 tests pin the power normalisation at every transform size and through every window, the
> band-integration invariants, and the agreement between the band levels and the spectrum they come
> from — and the running app is checked against its own pink-noise source, which a
> constant-percentage-bandwidth display must draw flat. It has **not** been verified against a
> calibrated measurement microphone or a reference analyser, and no absolute SPL claim is made: the
> dB offset field is an unverified user-supplied number, and there is no microphone correction.

A real-time audio analyser that runs entirely in a browser tab.

- **RTA** at 1/3, 1/6, 1/12, 1/24 or 1/48 octave
- **FFT size** 2048 to 65536, with a selectable analysis window and overlap
- **Peak hold** per band, and exponential or infinite averaging
- **Spectrograph** sharing the RTA's frequency axis
- **Full-height bargraph meter** — peak, RMS, peak hold and a latching clip
  indicator, plus broadband Z / A / C readouts

No backend, no accounts, no telemetry. The audio is analysed on the page and
never leaves the browser.

---

## Sources

**An audio input** — a microphone, a measurement mic on an interface, or a
return from a console. The browser's echo cancellation, noise suppression and
automatic gain are all switched off, so what you see is the signal rather than
the voice pipeline the browser would otherwise hand you.

**Tab audio** — captures what another browser tab is playing. Pick a tab in the
picker and tick "Share tab audio". Whole-window and full-screen shares carry no
audio on most platforms. Chrome and Edge only.

**Pink noise** — generated in the page and analysed without going anywhere near
the speakers. Pink noise is flat on a constant-percentage-bandwidth display, so
this is the check that the analyser reads level before you trust what it says
about a room.

## Reading the display

Levels are **dBFS**, on the convention that a full-scale sine reads 0 dB. The
offset field adds a constant to everything shown, so if you have a reference of
known level you can dial the scale into SPL — nothing verifies that number, and
no microphone correction is applied.

### The shaded region

At the fine resolutions the low bands are narrower than the transform can
actually resolve. Below the frequency stated under the controls, neighbouring
bands report shares of a single measurement rather than independent ones, and
the RTA shades that part of the graph. It is not a fault: it is the arithmetic
of asking a 341 ms transform for 1/48-octave detail at 30 Hz. Lengthen the
transform, or use a coarser resolution, and the shading recedes.

| Resolution | 16384-point transform, 48 kHz | 65536-point |
|---|---|---|
| 1/3 octave | resolved from 20 Hz | 20 Hz |
| 1/12 octave | 76 Hz | 19 Hz |
| 1/48 octave | 304 Hz | 76 Hz |

### Which window

**Hann** for anything ordinary. **Blackman-Harris** to see a quiet tone next to
a loud one — it buys −92 dB sidelobes at the cost of a wider main lobe.
**Flat-top** when the amplitude of a tone matters more than its frequency; it is
accurate to about 0.01 dB wherever the tone falls between bins, and has poor
frequency resolution in exchange. **Rectangular** only for signals that are
periodic within the frame.

## Development

```bash
npm install
npm run dev
npm test
npm run build
```

See [AGENTS.md](AGENTS.md) for the measurement model and the traps, and
[CLAUDE.md](CLAUDE.md) for the command reference.

## Licence

MIT. See [LICENSE](LICENSE).
