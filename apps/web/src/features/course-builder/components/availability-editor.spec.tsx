import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvailabilityEditor, type AvailabilityNodeModel } from './availability-editor';

/**
 * Spec trình sửa cây availability: mô hình phát ra qua `onChange` phải
 * khớp đúng hình dạng cây JSON phía API (nút `{ op, c, show?, showc? }`,
 * lá date/grade/completion/group/grouping/profile với đúng khoá tham số
 * mà evaluator của backend đọc — đối chiếu availability.service và các
 * evaluator đăng ký ở completion/groups service).
 */
const GROUP_ID = '01900000-0000-7000-8000-000000002001';
const GROUPING_ID = '01900000-0000-7000-8000-000000002002';
const MODULE_ID = '01900000-0000-7000-8000-000000001000';
const GRADE_ITEM_ID = '01900000-0000-7000-8000-000000003001';

const CTX = {
  groups: [{ id: GROUP_ID, name: 'Nhóm 1' }],
  groupings: [{ id: GROUPING_ID, name: 'Grouping A' }],
  modules: [{ id: MODULE_ID, name: 'Welcome page' }],
  gradeItems: [{ id: GRADE_ITEM_ID, name: 'Quiz 1' }],
};

function renderEditor(value: unknown, calls: unknown[]) {
  render(
    <AvailabilityEditor
      value={value}
      onChange={(next) => calls.push(next)}
      groups={CTX.groups}
      groupings={CTX.groupings}
      modules={CTX.modules}
      gradeItems={CTX.gradeItems}
    />,
  );
}

function lastPayload(calls: unknown[]): AvailabilityNodeModel {
  return calls[calls.length - 1] as AvailabilityNodeModel;
}

describe('Khối AvailabilityEditor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('render cây sẵn có với lá ngày và nhóm OR lồng chứa lá nhóm', () => {
    const calls: unknown[] = [];
    renderEditor(
      {
        op: '&',
        show: true,
        showc: [true, true],
        c: [
          { type: 'date', d: '>=', t: 1893456000 },
          { op: '|', c: [{ type: 'group', id: GROUP_ID }] },
        ],
      },
      calls,
    );

    const root = screen.getByTestId('availability-node-root');
    // Select của @lms/ui: trigger hiện chữ của tuỳ chọn đang chọn thay cho value của <select> native.
    expect(screen.getByTestId('avail-op-root')).toHaveTextContent('Tất cả điều kiện (AND)');
    expect(within(root).getByLabelText('Mốc thời gian')).not.toHaveValue('');
    const nested = screen.getByTestId('availability-node-1');
    expect(screen.getByTestId('avail-op-1')).toHaveTextContent('Bất kỳ điều kiện nào (OR)');
    expect(within(nested).getByLabelText('Nhóm')).toHaveTextContent('Nhóm 1');
  });

  it('phát cây với toán tử mới khi toán tử gốc thay đổi', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'group', id: GROUP_ID }] }, calls);

    await userEvent.click(screen.getByTestId('avail-op-root'));
    await userEvent.click(await screen.findByRole('option', { name: 'Không điều kiện nào đúng (NOT OR)' }));

    expect(lastPayload(calls).op).toBe('!|');
    expect(lastPayload(calls).c).toEqual([{ type: 'group', id: GROUP_ID }]);
  });

  it('thêm điều kiện điểm trỏ tới mục điểm đầu tiên', async () => {
    const calls: unknown[] = [];
    renderEditor(null, calls);
    const root = screen.getByTestId('availability-node-root');

    await userEvent.click(within(root).getByLabelText('Loại điều kiện mới'));
    await userEvent.click(await screen.findByRole('option', { name: 'Điểm' }));
    await userEvent.click(within(root).getByRole('button', { name: 'Thêm điều kiện' }));

    const payload = lastPayload(calls);
    expect(payload.c).toHaveLength(1);
    expect(payload.c[0]).toMatchObject({ type: 'grade', id: GRADE_ITEM_ID });
  });

  it('dựng nhóm lồng chứa điều kiện hoàn thành bên trong', async () => {
    const calls: unknown[] = [];
    renderEditor(null, calls);
    const root = screen.getByTestId('availability-node-root');

    await userEvent.click(within(root).getByRole('button', { name: 'Thêm nhóm điều kiện' }));
    const nested = screen.getByTestId('availability-node-0');
    await userEvent.click(within(nested).getByLabelText('Loại điều kiện mới'));
    await userEvent.click(await screen.findByRole('option', { name: 'Hoàn thành hoạt động' }));
    await userEvent.click(within(nested).getByRole('button', { name: 'Thêm điều kiện' }));

    const payload = lastPayload(calls);
    const child = payload.c[0] as AvailabilityNodeModel;
    expect(child.op).toBe('&');
    expect(child.c[0]).toEqual({ type: 'completion', id: MODULE_ID, state: 1 });
  });

  it('phát null khi điều kiện cuối cùng bị xoá', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'group', id: GROUP_ID }] }, calls);

    await userEvent.click(screen.getByRole('button', { name: 'Xoá điều kiện' }));

    expect(calls[calls.length - 1]).toBeNull();
  });

  it('giữ nguyên loại lá lạ trong khi sửa xung quanh chúng', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'futureplugin', level: 3 }] }, calls);

    expect(screen.getAllByText(/futureplugin/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByTestId('avail-op-root'));
    await userEvent.click(await screen.findByRole('option', { name: 'Bất kỳ điều kiện nào (OR)' }));

    expect(lastPayload(calls).c).toEqual([{ type: 'futureplugin', level: 3 }]);
  });
});
