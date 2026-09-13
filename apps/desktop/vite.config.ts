import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 渲染层构建配置。
 *
 * 两个关键点：
 *  - base: './'  产物由 Electron 以 file:// 加载，必须是相对路径；
 *  - CSP 只在生产构建注入，开发期由 Vite HMR 接管（内联脚本会被严格 CSP 拦截）。
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [
    react(),
    {
      name: 'deepwork-csp',
      transformIndexHtml(html, ctx) {
        if (ctx.server) return html;
        return html.replace(
          '</head>',
          `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@deepwork/protocol': path.resolve(__dirname, '../../packages/protocol/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: true,
  },
});
