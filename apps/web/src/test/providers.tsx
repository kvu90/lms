import { useState, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '#lib/auth';
import { PermissionsProvider } from '#lib/permissions';
import { createQueryClient } from '#lib/query-client';

/**
 * Bộ provider cho test, mô phỏng đúng cây provider của root.tsx
 * (QueryClientProvider → AuthProvider → PermissionsProvider) nhưng mỗi
 * lần render là MỘT QueryClient mới (cache sạch giữa các test, tắt
 * retry để lỗi API trong stub hiện ngay thay vì thử lại theo hàm mũ).
 */
export function TestProviders({ children }: { children: ReactNode }) {
  const [client] = useState(() => {
    const created = createQueryClient();
    created.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
    return created;
  });
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <PermissionsProvider>{children}</PermissionsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
