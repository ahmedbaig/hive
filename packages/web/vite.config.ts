import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

/**
 * Fontsource emits `format("woff2-variations")` in its @font-face rules. That
 * string was dropped from the CSS Fonts spec: Chrome and Edge treat it as an
 * unknown format and discard the whole rule, so every webfont silently fails
 * and the page falls back through the stack to Arial. The modern spelling is
 * plain `format("woff2")`.
 *
 * Rewriting the generated CSS is more robust than pinning a fontsource version
 * that happens to emit the right thing today.
 */
function fixWoff2Format(): Plugin {
  const rewrite = (css: string): string =>
    css.replace(/format\((['"])woff2-variations\1\)/g, 'format("woff2")');

  return {
    name: 'hive:fix-woff2-format',
    enforce: 'post',
    // Dev server: patch as each stylesheet is transformed.
    transform(code, id) {
      if (id.endsWith('.css') && code.includes('woff2-variations')) {
        return { code: rewrite(code), map: null };
      }
      return null;
    },
    // Build: patch the emitted CSS assets.
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          const source = typeof file.source === 'string' ? file.source : file.source.toString();
          if (source.includes('woff2-variations')) file.source = rewrite(source);
        }
      }
    },
  };
}

/**
 * In dev the SPA is served by Vite and proxies API and WebSocket traffic to the
 * hive server, so the browser sees one origin and no CORS dance. In production
 * the server serves `dist/` directly and the proxy is unused.
 */
export default defineConfig({
  plugins: [react(), fixWoff2Format()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7777', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
