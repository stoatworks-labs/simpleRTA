import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Static SPA. Output goes to dist/, which is what the Cloudflare Worker publishes.
//
// `base` is relative so the built page also works when opened from a file path or
// served under a sub-directory. The AudioWorklet processor is NOT bundled — it
// lives in public/ and is loaded by URL at runtime (see src/lib/analyser.ts).
export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
