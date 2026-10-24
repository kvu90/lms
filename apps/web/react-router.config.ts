import type { Config } from '@react-router/dev/config';

/**
 * Cấu hình React Router FRAMEWORK mode — Giai đoạn 4 của issue #7:
 * SSR (`ssr: true`) cho TOÀN BỘ route. `react-router build` sinh cả
 * server build (`build/server`) cạnh client build (`build/client`);
 * tiến trình SSR riêng (apps/web/server/prod-server.mjs) chạy server
 * build đó và proxy `/api/*` về API qua localhost (topology C: hai
 * tiến trình trong cùng một dyno). Mọi route đều render phía server:
 * route công khai có loader lấy dữ liệu thật (login/health), vỏ trang
 * cá nhân hoá theo cookie phiên qua loader gốc, dữ liệu trang của các
 * route đã đăng nhập tải phía client như trước (token Bearer ở
 * localStorage — server không đọc được; cơ chế loader theo cookie đã
 * có sẵn trong lib/server-api.ts cho khi phiên cookie thành luồng
 * chính ở Giai đoạn 2). Mã nguồn giữ trong `src/` (appDirectory).
 */
export default {
  ssr: true,
  appDirectory: 'src',
} satisfies Config;
