/** Route module: trang backup nền tảng ở module riêng pages/platform-backup.tsx (tách từ platform.tsx — F-10 của #133). */
export { BackupPage as default } from '../pages/platform-backup';

// Biên lỗi + tiêu đề theo route (cụm khung SSR #146, từ rà soát #133).
export { RouteErrorBoundary as ErrorBoundary } from '../components/route-error-boundary';
import { platformKeyMeta } from '../lib/route-meta';
export function meta() {
  return platformKeyMeta('backupTitle');
}

// clientLoader (F-01, rà soát #133): prefetch danh sách việc sao lưu vào QueryClient singleton.
export { backupPageClientLoader as clientLoader } from '../lib/platform-data';
