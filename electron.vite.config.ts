import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Prevent parent shell ELECTRON_RUN_AS_NODE from leaking into spawned electron process
delete process.env.ELECTRON_RUN_AS_NODE

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
