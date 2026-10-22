import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

/**
 * Ngân sách chờ cho các assertion bất đồng bộ (waitFor/findBy*): mặc định
 * 1 giây của Testing Library quá sát khi turbo chạy song song nhiều
 * package trên máy đang tải — test UI từng fail rải rác ở các file khác
 * nhau giữa các lần chạy dù logic đúng. 10 giây vẫn đủ ngắn để bắt lỗi
 * treo thật.
 */
configure({ asyncUtilTimeout: 10_000 });
