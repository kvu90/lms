import { Editor, type JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import {
  CHOICE_LIST_NODE_TYPE,
  CHOICE_NODE_TYPE,
  MULTIPLE_CHOICE_COUNT,
  multipleChoiceExtensions,
} from './multiple-choice.js';
import {
  STATEMENT_LIST_NODE_TYPE,
  STATEMENT_NODE_TYPE,
  TRUE_FALSE_STATEMENT_COUNT,
  trueFalseExtensions,
} from './true-false.js';

/**
 * Bất biến định danh trong tài liệu soạn (ghi nhận từ ĐG P4, bổ sung
 * theo phán quyết ĐG cuối chuỗi 6419937157): mọi node choice (MC) và
 * statement (TF-A) trong tài liệu soạn phải mang `attrs.id` chuỗi —
 * đáp án đúng của MC và đáp án Đ/S từng mệnh đề của TF-A đều bám theo
 * id này qua kéo-thả/tách-gộp đoạn, nên tài liệu nạp vào mà thiếu id
 * là dữ liệu hỏng nếu không được gán bù.
 *
 * Các ca dưới đây khẳng định bất biến ở mức hành vi tài liệu (nạp
 * tài liệu thiếu id, qua một transaction thì mọi node đều có id),
 * không soi chi tiết nội bộ plugin/transaction của TipTap: thứ tự
 * nội dung giữ nguyên, id phân biệt nhau, đều là chuỗi không rỗng.
 */
describe('unique id invariant in authoring documents', () => {
  it('multipleChoice: choices lacking attrs.id all gain distinct string ids, content order unchanged', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: multipleChoiceExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Chọn đáp án đúng:' }] },
          {
            type: CHOICE_LIST_NODE_TYPE,
            content: ['A', 'B', 'C', 'D'].map((label) => ({
              type: CHOICE_NODE_TYPE,
              // Cố tình thiếu attrs.id: tài liệu nạp vào chưa có, hoặc
              // choice vừa sinh ra khi người soạn tách/gộp đoạn.
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Phương án ${label}` }] }],
            })),
          },
        ],
      },
    });
    try {
      // Một transaction nạp lại tài liệu sẽ chạy qua plugin gán id.
      editor.commands.setContent(editor.getJSON());
      const json = editor.getJSON() as { content?: JSONContent[] };
      const choiceList = (json.content ?? []).find((node) => node?.type === CHOICE_LIST_NODE_TYPE);
      const choices = choiceList?.content ?? [];
      expect(choices).toHaveLength(MULTIPLE_CHOICE_COUNT);
      const ids = choices.map((choice) => choice?.attrs?.id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(MULTIPLE_CHOICE_COUNT);
      // Id được gán bù không được xáo trộn thứ tự hay nội dung lựa chọn:
      // đáp án đúng trỏ theo id vẫn khớp đúng nội dung sau khi gán.
      expect(choices.map((choice) => choice?.content?.[0]?.content?.[0]?.text)).toEqual([
        'Phương án A',
        'Phương án B',
        'Phương án C',
        'Phương án D',
      ]);
    } finally {
      editor.destroy();
      element.remove();
    }
  });

  it('trueFalse: statements lacking attrs.id all gain distinct string ids, content order unchanged', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: trueFalseExtensions,
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Xét các mệnh đề:' }] },
          {
            type: STATEMENT_LIST_NODE_TYPE,
            content: ['a', 'b', 'c', 'd'].map((label) => ({
              type: STATEMENT_NODE_TYPE,
              // Cố tình thiếu attrs.id — cùng trường hợp như choice ở trên.
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${label}` }] }],
            })),
          },
        ],
      },
    });
    try {
      editor.commands.setContent(editor.getJSON());
      const json = editor.getJSON() as { content?: JSONContent[] };
      const statementList = (json.content ?? []).find((node) => node?.type === STATEMENT_LIST_NODE_TYPE);
      const statements = statementList?.content ?? [];
      expect(statements).toHaveLength(TRUE_FALSE_STATEMENT_COUNT);
      const ids = statements.map((statement) => statement?.attrs?.id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(TRUE_FALSE_STATEMENT_COUNT);
      expect(statements.map((statement) => statement?.content?.[0]?.content?.[0]?.text)).toEqual([
        'Mệnh đề a',
        'Mệnh đề b',
        'Mệnh đề c',
        'Mệnh đề d',
      ]);
    } finally {
      editor.destroy();
      element.remove();
    }
  });
});
