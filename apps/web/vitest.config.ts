import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Cấu hình Vitest tách khỏi vite.config.ts: test render component bằng
 * plugin React thường trong jsdom, không qua plugin framework của React
 * Router (plugin đó dành cho dev/build và tự quản vòng đời route).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
    // Trần mặc định 5s quá sát cho test UI khi chạy song song dưới tải.
    testTimeout: 20_000,
  },
});
