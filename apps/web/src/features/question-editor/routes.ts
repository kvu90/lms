import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature question-editor: soạn câu hỏi mới và sửa câu hỏi.
 */
export default [
  route('questions/new', 'routes/question-new.tsx'),
  route('questions/:questionId/edit', 'routes/question-edit.tsx'),
] satisfies RouteConfig;
