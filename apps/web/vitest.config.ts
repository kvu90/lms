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
  test: {
    environment: 'jsdom',
    // Pool vmThreads: môi trường jsdom chỉ tạo MỘT lần cho mỗi worker
    // thay vì tạo lại theo từng file test (trước đây jsdom được tạo lại
    // đúng số file, chiếm khoảng một phần tư tổng thời gian chạy test).
    // Khác với `isolate: false`, mỗi file vẫn chạy trong VM context
    // riêng nên độ cô lập giữa các file được giữ nguyên; đánh đổi duy
    // nhất là các file trong cùng worker dùng chung một tiến trình.
    pool: 'vmThreads',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.tsx', 'src/**/*.spec.ts'],
    // Trần mặc định 5s quá sát cho test UI khi chạy song song dưới tải.
    testTimeout: 20_000,
  },
});
