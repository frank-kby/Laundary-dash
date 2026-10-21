import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer', // external script, compatible with the strict CSP (no inline JS)
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'Laundry Dash',
        short_name: 'Laundry Dash',
        description: 'Laundry pickup and delivery in Kigali',
        theme_color: '#13203b',
        background_color: '#F6F9FC',
        display: 'standalone',
        orientation: 'portrait',
        categories: ['lifestyle', 'shopping'],
        start_url: '/',
        scope: '/',
        lang: 'en',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell is cached. API responses are never cached by the service worker
        // (they are private and change constantly); offline API calls fail visibly instead.
        globPatterns: ['**/*.{js,css,html,png,webp,svg,woff2}'],
        globIgnores: ['**/*vietnamese*', '**/*latin-ext*'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/],
        runtimeCaching: [],
      },
    }),
  ],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000', '/healthz': 'http://localhost:3000' } },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 400 },
});
