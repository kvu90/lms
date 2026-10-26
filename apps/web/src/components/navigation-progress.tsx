import { useEffect, useState } from 'react';
import { useNavigation } from 'react-router';

/**
 * Trạng thái chờ điều hướng toàn cục (F-14, rà soát #133): khi router
 * đang tải trang đích (`navigation.state === 'loading'` — kể từ khi
 * các trang có clientLoader, pha này là lúc dữ liệu trang đích đang
 * được nạp), hiện chỉ báo sau một khoảng trễ ngắn 150ms để điều hướng
 * nhanh không gây nhấp nháy. Tắt ngay khi điều hướng xong.
 */
export function useNavigationPending(): boolean {
  const navigation = useNavigation();
  const loading = navigation.state === 'loading';
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 150);
    return () => window.clearTimeout(timer);
  }, [loading]);
  return visible;
}

/**
 * Thanh tiến trình mảnh ở đỉnh màn hình khi đang chờ điều hướng
 * (F-14): thanh mảnh chạy pulse trong lúc chờ — thuần chỉ báo, không
 * chặn tương tác.
 */
export function NavigationProgressBar({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden">
      <div className="h-full w-full animate-pulse bg-primary" />
    </div>
  );
}
