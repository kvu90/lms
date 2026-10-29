/**
 * Cấu hình ESLint dạng phẳng (flat config) cho toàn repo.
 *
 * Cấu trúc theo đúng pattern chính thức của từng thư viện:
 * - File JavaScript thuần: bộ `recommended` của ESLint (`@eslint/js`)
 *   kèm globals của Node.
 * - Code TypeScript: bộ `recommended` của ESLint + bộ `recommended`
 *   của typescript-eslint (bộ không cần thông tin kiểu — nền lint
 *   chưa dùng các rule type-checked).
 * - Code React (`apps/web`, `packages/ui`, `packages/editor`): preset
 *   `flat.recommended` của eslint-plugin-react-hooks.
 * - File test: preset `recommended` của `@vitest/eslint-plugin`, áp
 *   riêng theo glob của dự án (`*.spec.*`, `*.int-spec.*`,
 *   `*.e2e-spec.*`) — file test không lint chung bộ rule của code
 *   nguồn.
 *
 * Lint chạy qua script `lint` ở gốc (hoặc `turbo run lint`) và chưa
 * phải cổng chặn trong CI.
 */
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.turbo/**",
    "**/.react-router/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: [
      "apps/web/**/*.{ts,tsx}",
      "packages/ui/**/*.{ts,tsx}",
      "packages/editor/**/*.{ts,tsx}",
    ],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ["**/*.spec.{ts,tsx}", "**/*.int-spec.{ts,tsx}", "**/*.e2e-spec.{ts,tsx}"],
    ...vitest.configs.recommended,
  },
]);
