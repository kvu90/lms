import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature platform: các trang nền tảng (tìm kiếm, token tích hợp, sao lưu, insights, báo cáo, riêng tư).
 */
export default [
  route('search', 'routes/platform-search.tsx'),
  route('tokens', 'routes/platform-tokens.tsx'),
  route('backup', 'routes/platform-backup.tsx'),
  route('insights', 'routes/platform-insights.tsx'),
  route('reports', 'routes/platform-reports.tsx'),
  route('privacy', 'routes/platform-privacy.tsx'),
] satisfies RouteConfig;
