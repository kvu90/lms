import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '#lib/query-client';
import { CourseCardPrefEditor } from './course-card-pref-editor';
import '#config/i18n';

/**
 * Spec của editor tuỳ biến thẻ khoá — viết lại theo rà soát #219.
 * Bản cũ khẳng định cơ chế invalidate của React Query (đếm số lần GET
 * course-cards trước/sau khi lưu) — chi tiết triển khai: đổi cách làm tươi
 * dữ liệu mà hành vi giữ nguyên vẫn bị đỏ oan. Bản này chỉ khẳng định hợp
 * đồng nghiệp vụ: chọn màu rồi Lưu thì gửi đúng pref lên API của đúng khoá
 * và báo lại pref đã lưu cho nơi gọi. (Việc thẻ khoá hiện màu/biệt danh đã
 * lưu được khẳng định ở courses.spec.tsx — ca DASH1 thẻ khoá.)
 */

const COURSE_ID = '01900000-0000-7000-8000-000000000010';

describe('CourseCardPrefEditor — lưu tuỳ biến thẻ khoá', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('chọn màu rồi lưu: PUT đúng pref của đúng khoá và báo onSaved', async () => {
    const puts: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const respond = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url === `/api/v1/dashboard/course-cards/${COURSE_ID}` && init?.method === 'PUT') {
          puts.push({ url, body: JSON.parse(String(init.body)) });
          return respond({ courseId: COURSE_ID, color: 'red', nickname: null });
        }
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
      }),
    );

    const onSaved = vi.fn();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <CourseCardPrefEditor courseId={COURSE_ID} initial={undefined} onSaved={onSaved} onCancel={() => undefined} />
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByTestId('card-color-red'));
    await userEvent.click(screen.getByTestId('card-pref-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ courseId: COURSE_ID, color: 'red', nickname: null }));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toMatchObject({ color: 'red' });
  });
});
