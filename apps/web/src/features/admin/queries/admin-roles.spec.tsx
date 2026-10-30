import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { useSetCapabilityOverride } from './admin-roles';
import { queryKeys } from './keys';

/**
 * Spec tầng queries của feature admin (issue #570): đột biến ghi một ô
 * ma trận (POST /access/overrides) khi thành công phải làm mới cả gốc
 * ma trận của feature lẫn tiền tố `access` dùng chung — nếu thiếu vế
 * thứ hai, hộp thoại ma trận và lưới thẻ của trang Vai trò giữ dữ
 * liệu cũ trong cửa sổ staleTime 30 giây sau khi sửa ở Permissions.
 */
const ROLE_A_ID = '01900000-0000-7000-8000-0000000000b1';
const SYSTEM_CONTEXT_ID = '01900000-0000-7000-8000-000000000010';

describe('useSetCapabilityOverride — làm mới cache sau khi ghi ô (#570)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ghi ô thành công thì vô hiệu hóa cả gốc ma trận của feature và tiền tố access dùng chung', async () => {
    let postedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      postedInit = init;
      return new Response(JSON.stringify({ updated: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useSetCapabilityOverride(), { wrapper });
    try {
      await act(async () => {
        await result.current.mutateAsync({
          roleId: ROLE_A_ID,
          capability: 'course:edit',
          contextId: SYSTEM_CONTEXT_ID,
          permission: 1,
        });
      });
    } finally {
      unmount();
    }
    // Lần ghi đã thực sự gọi đúng endpoint với đúng thân.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedInit?.method).toBe('POST');
    expect(JSON.parse(String(postedInit?.body ?? '{}'))).toEqual({
      roleId: ROLE_A_ID,
      capability: 'course:edit',
      contextId: SYSTEM_CONTEXT_ID,
      permission: 1,
    });
    // Cả hai lần vô hiệu hóa đều xảy ra: gốc ma trận của feature và
    // tiền tố access dùng chung (trang Vai trò đọc qua tiền tố này).
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.capabilityMatrixRoot });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sharedQueryKeys.access });
  });
});
