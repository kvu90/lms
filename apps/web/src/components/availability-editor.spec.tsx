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

describe('AvailabilityEditor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders an existing tree with a date leaf and a nested OR group holding a group leaf', () => {
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
    expect(screen.getByTestId('avail-op-root')).toHaveValue('&');
    expect(within(root).getByLabelText('Mốc thời gian')).not.toHaveValue('');
    const nested = screen.getByTestId('availability-node-1');
    expect(screen.getByTestId('avail-op-1')).toHaveValue('|');
    expect(within(nested).getByLabelText('Nhóm')).toHaveValue(GROUP_ID);
  });

  it('emits the tree with the new operator when the root operator changes', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'group', id: GROUP_ID }] }, calls);

    await userEvent.selectOptions(screen.getByTestId('avail-op-root'), '!|');

    expect(lastPayload(calls).op).toBe('!|');
    expect(lastPayload(calls).c).toEqual([{ type: 'group', id: GROUP_ID }]);
  });

  it('adds a grade condition pointing at the first grade item', async () => {
    const calls: unknown[] = [];
    renderEditor(null, calls);
    const root = screen.getByTestId('availability-node-root');

    await userEvent.selectOptions(within(root).getByLabelText('Loại điều kiện mới'), 'grade');
    await userEvent.click(within(root).getByRole('button', { name: 'Thêm điều kiện' }));

    const payload = lastPayload(calls);
    expect(payload.c).toHaveLength(1);
    expect(payload.c[0]).toMatchObject({ type: 'grade', id: GRADE_ITEM_ID });
  });

  it('builds a nested group with a completion condition inside it', async () => {
    const calls: unknown[] = [];
    renderEditor(null, calls);
    const root = screen.getByTestId('availability-node-root');

    await userEvent.click(within(root).getByRole('button', { name: 'Thêm nhóm điều kiện' }));
    const nested = screen.getByTestId('availability-node-0');
    await userEvent.selectOptions(within(nested).getByLabelText('Loại điều kiện mới'), 'completion');
    await userEvent.click(within(nested).getByRole('button', { name: 'Thêm điều kiện' }));

    const payload = lastPayload(calls);
    const child = payload.c[0] as AvailabilityNodeModel;
    expect(child.op).toBe('&');
    expect(child.c[0]).toEqual({ type: 'completion', id: MODULE_ID, state: 1 });
  });

  it('emits null once the last condition is removed', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'group', id: GROUP_ID }] }, calls);

    await userEvent.click(screen.getByRole('button', { name: 'Xoá điều kiện' }));

    expect(calls[calls.length - 1]).toBeNull();
  });

  it('keeps unknown leaf types untouched while editing around them', async () => {
    const calls: unknown[] = [];
    renderEditor({ op: '&', c: [{ type: 'futureplugin', level: 3 }] }, calls);

    expect(screen.getAllByText(/futureplugin/).length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByTestId('avail-op-root'), '|');

    expect(lastPayload(calls).c).toEqual([{ type: 'futureplugin', level: 3 }]);
  });
});
