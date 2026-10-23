import type { Config } from '@react-router/dev/config';

/**
 * Cấu hình React Router FRAMEWORK mode (theo tài liệu chính thức hiện
 * hành): chạy dạng SPA (`ssr: false`) — `react-router build` dựng sẵn vỏ
 * trang (root route kèm HydrateFallback) vào thư mục tĩnh `build/client`
 * để API tiếp tục phục vụ như một SPA, không cần tiến trình Node riêng
 * cho frontend. Mã nguồn giữ trong `src/` (appDirectory) để không xáo
 * trộn cấu trúc components/lib/pages hiện có.
 */
export default {
  ssr: false,
  appDirectory: 'src',
} satisfies Config;
