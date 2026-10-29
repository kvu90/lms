import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature matrices: cụm ma trận đã tách khỏi cây /questions (chuẩn đường dẫn #221, lát R1) — path chính ở /matrices/*; hai path cũ giữ làm lớp tương thích chuyển hướng thay thế (mục 3.5 của hồ sơ chuẩn).
 */
export default [
  route('matrices/new', 'routes/question-matrix-new.tsx'),
  route('matrices/import', 'routes/matrix-import.tsx'),
  route('matrices/:matrixId/edit', 'routes/question-matrix-edit.tsx'),
  route('questions/matrices/new', 'routes/legacy-matrix-new.tsx'),
  route('questions/matrices/:matrixId/edit', 'routes/legacy-matrix-edit.tsx'),
] satisfies RouteConfig;
