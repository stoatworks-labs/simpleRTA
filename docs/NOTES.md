# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*simpleRTA — browser real-time audio analyser (1/3–1/48 octave RTA, spectrograph, full-height meter). PRIVATE repo, LIVE, on the website, video cut.*

**PUBLIC since 2026-08-05** — the private-repo statements below are historical; the repo, its Docker packaging and its `/software` page are all live. See [browser tools published](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/project_browser_tools_published.md).

**simpleRTA** — a real-time audio analyser that runs entirely in a browser tab.
Fractional-octave RTA from 1/3 to 1/48, a scrolling spectrograph on the same
frequency axis, and a full-height peak/RMS bargraph meter styled after the
[atem overseer](https://github.com/stoatworks-labs/atem-overseer/blob/main/docs/NOTES.md) (`atem-overseer`) meters. React 19 + TS + Vite, no backend.

- Repo `stoatworks-labs/simpleRTA`, **PRIVATE**, `main`. Started 2026-08-01.
- Live at **https://simple-rta.stoatworks-labs.com** — hyphenated hostname, camel
  case repo. Custom domain declared in `wrangler.toml`, not the dashboard.
  Deployed with `cf-run npx wrangler deploy` (see [cloudflare access](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_cloudflare_access.md)).
- On the website under **/web-tools** (slug `simplerta`) — no `/software` page and
  no source link, because the repo is private. See [stoatworks website](https://github.com/stoatworks-labs/stoatworks-website/blob/main/docs/NOTES.md) (`stoatworks-website`).
- Video cut and ready at `stoatworks-backend/video/projects/simplerta/out/`,
  16:9 plus the Instagram reel. **Not published to YouTube or Instagram yet.**

**Verify it with the built-in pink-noise source, never a microphone.** Pink noise
is flat on a constant-percentage-bandwidth display, so a correct RTA draws a level
line at every resolution — a tilt, or a step at the shaded-region boundary, means
the analyser is wrong. A mic only tells you about the room. The noise is generated
in the page and never reaches the speakers, so this needs no hardware and no
permission prompt — including in headless Chrome, where Web Audio runs fine
against a null sink.

`scripts/shoot.mjs` re-takes the documentation screenshots from the running app
over CDP. The source must be started with a real `Input.dispatchMouseEvent`: an
AudioContext will not start without user activation and `element.click()` confers
none, and the failure is silent — everything responds and the analyser reads
silence.

The measurement model and the traps are in the repo's `AGENTS.md`. Read it before
touching `lib/bands.ts` or `lib/fft.ts`.

**Peak frequency strip (2026-09-11).** The readout across the top of the RTA names
the *tallest band of the averaged display* — never a separately derived number, so
it cannot disagree with the bars — and refines the frequency between bins only when
the averaged spectrum's strongest bin lies inside that band (plus a bin either side,
for the region where bands are narrower than bins). A tone therefore reads to a
fraction of a bin at every resolution ("997 Hz" at 1/3 octave, not "1k"); pink noise
reads the centre of whichever band is tallest, because the strongest *bin* of a pink
spectrum sits at the bottom of the range regardless, and quoting it would name a place
the graph shows nothing special. `peakBand` in `lib/bands.ts`, pinned by
`peak.test.ts`. The bin spectrum is averaged with the same weight as the bands for
this; the sibling `LEQtion` does the same in Rust. To inject a tone into the live
page for a check, reach the engine through the canvas's React fiber
(`memoizedProps.engine`) and hand `engine.attach()` a `MediaStreamAudioDestinationNode`
stream fed by an `OscillatorNode` — the app has no tone source of its own.
