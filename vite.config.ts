import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/**
 * Stamp the version this build produced onto the support-footer script tag.
 *
 * The tag itself stays in index.html — it is the same document in dev — but the
 * version cannot be written in beside it: a literal goes stale the moment a
 * release is tagged, and a feedback report naming the wrong build is worse than
 * one naming no build at all. Same string as __APP_VERSION__ below, which is
 * what the About dialog shows.
 */
function supportFooterVersion(): Plugin {
  // Not anchored to a leading slash: this runs after Vite has rewritten public
  // asset paths, and an app built with a relative `base` has ./support-footer.js
  // by the time we see it.
  const tag = /<script\s[^>]*\bsrc="[^"]*support-footer\.js"/
  return {
    name: 'stoatworks-support-footer-version',
    transformIndexHtml: {
      order: 'post',
      handler(html: string) {
        // Loud on purpose. The tag is hand-written markup, so a rename or a
        // tidy-up could silently detach the version from every report filed
        // afterwards, and nothing downstream would look wrong.
        if (!tag.test(html)) {
          throw new Error('no support-footer.js tag in index.html — nothing to stamp')
        }
        return html.replace(tag, (m) => `${m} data-version="v${pkg.version}"`)
      }
    }
  }
}

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
  plugins: [react(), supportFooterVersion()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
