import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import compression from 'vite-plugin-compression';
import { widgetDiscoveryPlugin } from './vite-plugin-widgets.ts';
import path from 'path';

export default defineConfig(({ mode, command }) => {
  // loadEnv with '' prefix loads all .env vars (not just VITE_-prefixed ones).
  // Inject into process.env so vite-plugin-widgets can read BASE_URL at build time.
  const env = loadEnv(mode, path.resolve(import.meta.dirname, '..'), '');
  if (env.BASE_URL && !process.env.BASE_URL) {
    process.env.BASE_URL = env.BASE_URL;
  }

  const isProd = process.env.NODE_ENV === 'production';
  // Dev builds feed the inline HTML fallback (hosts like claude.ai that
  // can't load external assets), so embed local images as data URIs there.
  const inlineAssets = env.INLINE_DEV_MODE === 'true' || !isProd;
  const widgetPort = Number(process.env.WIDGET_PORT || env.WIDGET_PORT || 4444);

  // When BASE_URL points at a tunnel to this dev server (e.g. ssh -R 0
  // pom.run), accept its Host header and point the HMR websocket at it.
  const baseUrl = (process.env.BASE_URL || env.BASE_URL || '').trim();
  const publicUrl = baseUrl ? new URL(baseUrl) : undefined;
  const tunneled =
    publicUrl &&
    publicUrl.hostname !== 'localhost' &&
    publicUrl.hostname !== '127.0.0.1';

  return {
    envDir: '..', // load .env from repo root for import.meta.env in client code
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    plugins: [
      react({
        jsxRuntime: 'automatic',
      }),
      widgetDiscoveryPlugin(),
      tailwindcss(),
      ...(isProd
        ? [
            compression({
              algorithm: 'gzip',
              ext: '.gz',
            }),
            compression({
              algorithm: 'brotliCompress',
              ext: '.br',
            }),
          ]
        : []),
    ],
    server: {
      port: widgetPort,
      strictPort: true,
      cors: true,
      fs: {
        allow: ['..'],
      },
      // The background watch build (npm run dev) rewrites ../assets on every
      // change; don't let those writes trigger full page reloads on top of HMR.
      watch: {
        ignored: [path.resolve(import.meta.dirname, '../assets') + '/**'],
      },
      ...(tunneled
        ? {
            allowedHosts: [publicUrl.hostname],
            hmr: {
              protocol: publicUrl.protocol === 'https:' ? 'wss' : 'ws',
              host: publicUrl.hostname,
              clientPort: publicUrl.port
                ? Number(publicUrl.port)
                : publicUrl.protocol === 'https:'
                  ? 443
                  : 80,
            },
          }
        : {}),
    },
    // Serve built assets through the dev server, but don't copy the output
    // directory onto itself during builds (outDir is also ../assets).
    publicDir: command === 'serve' ? '../assets' : false,
    build: {
      target: 'es2023',
      outDir: '../assets',
      emptyOutDir: false,
      sourcemap: true,
      ...(inlineAssets ? { assetsInlineLimit: 100 * 1024 } : {}), // 100KB in inline mode to embed local images as data URIs
      // Vite 8 uses the Oxc minifier by default (`minify: true`); the old
      // 'esbuild' string now requires esbuild to be installed as a separate
      // dependency, so we use the built-in minifier instead.
      minify: isProd,
      rolldownOptions: {
        output: {
          format: 'es',
          // Strip console/debugger calls in production. This replaces the old
          // terserOptions block, which never actually took effect because
          // minify wasn't set to 'terser'.
          ...(isProd
            ? {
                minify: {
                  compress: { dropConsole: true, dropDebugger: true },
                  mangle: true,
                },
              }
            : {}),
        },
      },
      chunkSizeWarningLimit: 500,
    },
  };
});
