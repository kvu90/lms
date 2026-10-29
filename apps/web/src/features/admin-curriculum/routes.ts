import { type RouteConfig, relative } from '@react-router/dev/routes';

const { prefix, route } = relative(import.meta.dirname);

/**
 * Khu route của feature admin-curriculum: quản trị chương trình
 * học (môn, chương trình, node, YCCĐ).
 */
export default prefix('admin/curriculum', [
  route('', 'routes/admin-curriculum.tsx'),
  route('subjects/new', 'routes/admin-curriculum-subject-new.tsx'),
  route('subjects/:subjectId/edit', 'routes/admin-curriculum-subject-edit.tsx'),
  route('subjects/:subjectId/curricula/new', 'routes/admin-curriculum-new.tsx'),
  route('curricula/:curriculumId', 'routes/admin-curriculum-tree.tsx'),
  route('curricula/:curriculumId/edit', 'routes/admin-curriculum-edit.tsx'),
  route('curricula/:curriculumId/nodes/new', 'routes/admin-curriculum-node-new.tsx'),
  route('nodes/:nodeId/edit', 'routes/admin-curriculum-node-edit.tsx'),
  route('nodes/:nodeId/outcomes/new', 'routes/admin-curriculum-outcome-new.tsx'),
  route('outcomes/:outcomeId/edit', 'routes/admin-curriculum-outcome-edit.tsx'),
]) satisfies RouteConfig;
