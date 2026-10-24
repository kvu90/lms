import type { Config } from '@react-router/dev/config';

/**
 * Cấu hình React Router FRAMEWORK mode — Giai đoạn 3 của issue #7:
 * bật SSR (`ssr: true`). `react-router build` nay sinh cả server build
 * (`build/server`) cạnh client build (`build/client`); tiến trình SSR
 * riêng (apps/web/server/prod-server.mjs) chạy server build đó và proxy
 * `/api/*` về API qua localhost (topology C: hai tiến trình trong cùng
 * một dyno). Ở giai đoạn prototype này chỉ các route công khai
 * (home/login/health) có loader lấy dữ liệu phía server; các route đã
 * đăng nhập giữ hành vi tải dữ liệu phía client như trước (SSR hoá
 * toàn bộ là Giai đoạn 4). Mã nguồn giữ trong `src/` (appDirectory).
 */
export default {
  ssr: true,
  appDirectory: 'src',
} satisfies Config;
