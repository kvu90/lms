import { type RouteConfig, relative } from '@react-router/dev/routes';

const { index } = relative(import.meta.dirname);

/**
 * Khu route của feature dashboard: trang chủ (index) của app. File này là config route riêng của feature (tách từ `src/routes.ts` theo mô hình features/, issue #500); file gốc ở tầng app chỉ gộp các khối feature vào layout chung.
 */
export default [
  index('routes/home-index.tsx'),
] satisfies RouteConfig;
