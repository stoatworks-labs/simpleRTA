import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static SPA. Output goes to dist/, which is what the Cloudflare Worker publishes.
//
// `base` is relative so the built page also works when opened from a file path or
// served under a sub-directory. The AudioWorklet processor is NOT bundled — it
// lives in public/ and is loaded by URL at runtime (see src/lib/analyser.ts).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
