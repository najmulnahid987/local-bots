import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Prevent parent shell ELECTRON_RUN_AS_NODE from leaking into spawned electron process
delete process.env.ELECTRON_RUN_AS_NODE

/**
 * Custom Vite plugin that dynamically manages Content-Security-Policy:
 * - Development: Allows the exact local Vite dev-server origin (http/ws on localhost:5173) and inline styles for HMR.
 * - Production: Strict lockdown with no dev server origins, no unsafe-inline, no unsafe-eval, and frame-src 'none'.
 */
function cspPlugin(): Plugin {
  return {
    name: 'html-csp-transform',
    transformIndexHtml(html, ctx) {
      const isDev = Boolean(ctx.server)

      const devServerOrigin = 'http://localhost:5173'
      const devWsOrigin = 'ws://localhost:5173'

      const devCsp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        `connect-src 'self' ${devServerOrigin} ${devWsOrigin}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'self'"
      ].join('; ')

      const prodCsp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'self'"
      ].join('; ')

      const csp = isDev ? devCsp : prodCsp
      const cspMetaTag = `<meta http-equiv="Content-Security-Policy" content="${csp};" />`

      if (/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i.test(html)) {
        return html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/i, cspMetaTag)
      }

      return html.replace('</head>', `  ${cspMetaTag}\n  </head>`)
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), cspPlugin()]
  }
})
