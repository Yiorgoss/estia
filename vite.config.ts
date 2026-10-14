import { cloudflare } from '@cloudflare/vite-plugin'
// import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
// import ssrPlugin from 'vite-ssr-components/plugin'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    }
  },
  server: {
    allowedHosts: ["server"],
  },
  // plugins: [tailwindcss(), cloudflare(), ssrPlugin()],
  plugins: [cloudflare()],
})

