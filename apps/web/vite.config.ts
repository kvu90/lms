import tailwindcss from '@tailwindcss/vite';
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * Cấu hình Vite cho React Router framework mode: plugin `reactRouter()`
 * thay cho plugin React thường (nó tự lo chia chunk theo route và dựng
 * vỏ trang SPA lúc build). Cấu hình test nằm ở vitest.config.ts riêng —
 * Vitest KHÔNG dùng plugin framework này.
 */
export default defineConfig({
  plugins: [reactRouter(), tailwindcss()],
  server: {
    port: 5173,
    // Cho phép mở bản dev qua đường hầm công khai khi review từ xa.
    allowedHosts: ['.lhr.life', '.trycloudflare.com', '.pinggy.net', '.pinggy-free.link'],
    proxy: { '/api': 'http://localhost:3000' },
  },
});
