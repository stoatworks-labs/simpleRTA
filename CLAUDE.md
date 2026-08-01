# CLAUDE.md — simpleRTA

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 29 tests
npm run test:watch
npm run build        # tsc -b && vite build -> dist/
npm run lint         # oxlint
npm run typecheck    # tsc -b
npm run preview      # serve the built dist/ (does NOT apply _headers)
```

## Deploy

```bash
cf-run npx wrangler deploy
```

`cf-run` supplies the Cloudflare API token from the keychain. Never `wrangler
login`. This is a Worker with static assets (`[assets] directory`), not Pages.

## Ground rules

- **Verify against the pink noise source, not a microphone.** Pink noise is flat
  on a constant-percentage-bandwidth display, so a correct RTA draws a level
  line at every resolution. A tilt or a step means the analyser is wrong.
- `integrateBands` integrates a spectral density between the band edges. Do not
  "simplify" it into summing the bins inside each band — that double-counts at
  the fine resolutions. See AGENTS.md §4.
- Power normalisation is `2/(N·S2)`, and a full-scale sine reads **0 dBFS**.
  `fft.test.ts` pins this at every size and through every window.
- The AudioWorklet lives in `public/rta-worklet.js` and is loaded by URL. It is
  not bundled, so it must be valid plain JS.
- Private repo. "Commit" = commit **and** push.
