import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature content-bank — Kho học liệu (chuẩn đường
 * dẫn #221, lát R3): tên tài nguyên viết tách là /content-bank;
 * cả ba path cũ viết dính giữ làm lớp tương thích chuyển hướng
 * thay thế sang path mới.
 */
export default [
  ...prefix('content-bank', [
    route('', 'routes/content-bank.tsx'),
    route('new', 'routes/content-bank-new.tsx'),
    route(':id/edit', 'routes/content-bank-edit.tsx'),
  ]),
  ...prefix('contentbank', [
    route('', 'routes/legacy-contentbank.tsx'),
    route('new', 'routes/legacy-contentbank-new.tsx'),
    route(':id/edit', 'routes/legacy-contentbank-edit.tsx'),
  ]),
] satisfies RouteConfig;
