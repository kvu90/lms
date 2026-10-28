import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OutcomeContent } from './program-group-table';
import type { CurriculumOutcomeDoc } from '#lib/curriculum';

/**
 * Spec phân cấp cha–con của YCCĐ trên bảng chương trình dùng chung:
 * một YCCĐ có ý con phải hiển thị quan hệ cha–con nhìn thấy được
 * (ý con kèm dấu gạch đầu dòng dưới ý cha, ý cháu lồng sâu hơn cũng
 * kèm dấu của nó), ở cả hai bề mặt dùng chung component này (quản
 * trị và giáo viên chỉ đọc — cùng một OutcomeContent). YCCĐ một
 * dòng hiển thị nguyên như trước. Nếu component quay lại render
 * phẳng theo dòng text (bỏ qua tài liệu), các ca có tài liệu phải
 * đỏ: dấu gạch đầu dòng của ý con biến mất.
 */

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const NESTED_DOC: CurriculumOutcomeDoc = {
  type: 'doc',
  content: [
    paragraph('Nêu được đặc điểm của hệ thống chính trị.'),
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            paragraph('Đảng Cộng sản Việt Nam.'),
            {
              type: 'bulletList',
              content: [
                { type: 'listItem', content: [paragraph('Vai trò lãnh đạo.')] },
              ],
            },
          ],
        },
        { type: 'listItem', content: [paragraph('Nhà nước.')] },
      ],
    },
  ],
};

const NESTED_TEXT = [
  'Nêu được đặc điểm của hệ thống chính trị.',
  'Đảng Cộng sản Việt Nam.',
  'Vai trò lãnh đạo.',
  'Nhà nước.',
].join('\n');

describe('OutcomeContent — phân cấp cha–con', () => {
  afterEach(() => cleanup());

  it('YCCĐ có ý con hiển thị ý con kèm dấu gạch đầu dòng dưới ý cha, ý cháu lồng sâu hơn cũng có dấu riêng', () => {
    render(<OutcomeContent content={NESTED_TEXT} contentDoc={NESTED_DOC} />);
    expect(screen.getByText('Nêu được đặc điểm của hệ thống chính trị.')).toBeTruthy();
    expect(screen.getByText('Đảng Cộng sản Việt Nam.')).toBeTruthy();
    expect(screen.getByText('Vai trò lãnh đạo.')).toBeTruthy();
    expect(screen.getByText('Nhà nước.')).toBeTruthy();
    // Ba ý thuộc danh sách (con + cháu + con thứ hai) đều có dấu
    // gạch đầu dòng của riêng mình; ý cha (đoạn văn) không có dấu.
    expect(screen.getAllByText('•').length).toBe(3);
  });

  it('YCCĐ một dòng hiển thị nguyên như trước, không thêm dấu hay khối', () => {
    render(<OutcomeContent content="Nêu được khái niệm số nguyên." />);
    expect(screen.getByText('Nêu được khái niệm số nguyên.')).toBeTruthy();
    expect(screen.queryByText('•')).toBeNull();
  });

  it('không có tài liệu thì giữ hành vi cũ: tách text theo dòng, không có dấu gạch đầu dòng', () => {
    render(<OutcomeContent content={NESTED_TEXT} />);
    for (const line of NESTED_TEXT.split('\n')) {
      expect(screen.getByText(line)).toBeTruthy();
    }
    expect(screen.queryByText('•')).toBeNull();
  });
});
