import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 5173,
    // Cho phép mở bản dev qua đường hầm công khai khi review từ xa.
    allowedHosts: ['.lhr.life', '.trycloudflare.com', '.pinggy.net', '.pinggy-free.link'],
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
    // Trần mặc định 5s quá sát cho test UI khi chạy song song dưới tải.
    testTimeout: 20_000,
  },
});
