import base from '@lms/config/eslint';
import { plugin as shadcn } from '@shadcn/lint';

// Cấu hình ESLint của app: bộ rule nền dùng chung của monorepo cộng
// plugin @shadcn/lint (linter chính thức của shadcn cho design system
// Tailwind) ở mức error — nó kiểm tra code TỰ VIẾT của app có tôn
// trọng token/variant của package @lms/ui hay không (component ui
// nguyên bản nằm ở packages/ui, không lint ở đây).
export default [
  ...base,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { shadcn },
    rules: {
      'shadcn/no-restyle': 'error',
      'shadcn/no-raw-colors': 'error',
      'shadcn/no-arbitrary-values': 'error',
      'shadcn/no-inline-styles': 'error',
      'shadcn/no-unknown-classes': 'error',
      'shadcn/require-static-classes': 'error',
    },
  },
];
