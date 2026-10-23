import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Cấu hình Vitest cho package editor: render component bằng plugin React
 * thường trong jsdom, giống cách apps/web kiểm thử component.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
    testTimeout: 20_000,
  },
});
