import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    // Tầng unit của package: spec cạnh mã nguồn trong `src`, hậu tố
    // `.spec.ts`. Khai `include` tường minh neo đúng thư mục + hậu tố
    // qua project, vì pattern khám phá mặc định của Vitest không phải
    // là căn cứ tách tầng của dự án (xem AGENTS.md ở gốc repo).
    projects: [
      { test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
    ],
  },
});
