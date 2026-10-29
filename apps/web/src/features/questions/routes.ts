import { type RouteConfig, relative } from '@react-router/dev/routes';

const { route } = relative(import.meta.dirname);

/**
 * Khu route của feature questions: ngân hàng câu hỏi, ngữ liệu, nơi dùng; gốc cây Đề (/exams) và gốc cây ma trận (/matrices) là trang khu vực của feature này; Ngân hàng hệ thống (chuẩn đường dẫn #221, lát R1): gốc chỉ chuyển hướng tới Câu hỏi hệ thống, ba khu vực có path riêng.
 */
export default [
  route('questions', 'routes/questions.tsx'),
  route('questions/stimuli', 'routes/question-stimuli.tsx'),
  route('questions/categories/new', 'routes/question-category-new.tsx'),
  route('matrices', 'routes/matrices.tsx'),
  route('question-usages/:id', 'routes/question-usage.tsx'),
  route('exams', 'routes/exams.tsx'),
  route('system-bank', 'routes/system-bank.tsx'),
  route('system-bank/questions', 'routes/system-bank-questions.tsx'),
  route('system-bank/exams', 'routes/system-bank-exams.tsx'),
  route('system-bank/papers', 'routes/legacy-system-bank-papers.tsx'),
  route('system-bank/matrices', 'routes/system-bank-matrices.tsx'),
] satisfies RouteConfig;
