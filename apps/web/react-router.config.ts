import type { Config } from '@react-router/dev/config';

/**
 * Cấu hình React Router FRAMEWORK mode — Giai đoạn 4 của issue #7:
 * SSR (`ssr: true`) cho TOÀN BỘ route. `react-router build` sinh cả
 * server build (`build/server`) cạnh client build (`build/client`);
 * tiến trình SSR riêng (apps/web/server/prod-server.mjs) chạy server
 * build đó và proxy `/api/*` về API qua localhost (topology C: hai
 * tiến trình trên cùng một máy). Mọi route đều render phía server:
 * route công khai có loader lấy dữ liệu thật (login/health), vỏ trang
 * cá nhân hoá theo cookie phiên qua loader gốc, dữ liệu trang của các
 * route đã đăng nhập tải phía client như trước (token Bearer ở
 * localStorage — server không đọc được; cơ chế loader theo cookie đã
 * có sẵn trong lib/server-api.ts cho khi phiên cookie thành luồng
 * chính ở Giai đoạn 2). Mã nguồn framework giữ trong `src/app/`
 * (appDirectory — gốc framework sau đợt tổ chức lại theo mô hình
 * features/, issue #500; các feature và tầng dùng chung nằm ở `src/`).
 *
 * Prerender (lát SL-1 của #7, theo bảng phân tầng route mục 5/6.5):
 * `/` (mặt CÔNG KHAI — bản build chạy loader không cookie nên chỉ
 * sinh mặt ẩn danh) và `/login` được render sẵn lúc build thành HTML
 * tĩnh trong build/client để giảm tải tiến trình SSR. Hai mặt này
 * chỉ được prod-server.mjs phục vụ tĩnh cho request KHÔNG mang
 * cookie phiên Better Auth; request có phiên luôn đi SSR động theo
 * đúng phiên đó (mặt đã đăng nhập của `/` không bao giờ là bản tĩnh).
 * `/health` giữ SSR động vì nội dung là trạng thái sống.
 */
export default {
  ssr: true,
  appDirectory: 'src/app',
  prerender: ['/', '/login'],
} satisfies Config;
