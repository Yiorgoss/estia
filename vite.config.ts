import { cloudflare } from "@cloudflare/vite-plugin";
// import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from "vite";
// import ssrPlugin from 'vite-ssr-components/plugin'
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    // The worker build runs in a Vite build environment whose consumer is
    // "server", and Vite 8 keeps the SSR default of no minification there.
    // Without this the worker ships with every JSDoc comment from Effect's
    // published dist and is three times larger (1.52 MB against 0.50 MB).
    minify: true,
    // Emit the map beside the worker so `upload_source_maps` in wrangler.jsonc
    // can upload it and production stack traces name source files. Wrangler
    // finds a map through the trailing sourceMappingURL comment, so this must
    // not be "hidden": a hidden map is written but never uploaded.
    sourcemap: true,
  },
  server: {
    allowedHosts: ["server"],
  },
  // plugins: [tailwindcss(), cloudflare(), ssrPlugin()],
  plugins: [cloudflare()],
});
