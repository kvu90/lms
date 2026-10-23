import base from '@lms/config/eslint';

// Cấu hình ESLint của app: chỉ dùng bộ rule nền dùng chung của
// monorepo. Component shadcn nguyên bản nằm ở packages/ui và được giữ
// đúng bản sinh ra bằng kỷ luật viết mã, không bằng linter chặn riêng.
export default [...base];
