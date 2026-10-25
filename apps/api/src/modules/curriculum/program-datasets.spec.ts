import { describe, expect, it } from 'vitest';
import {
  assertProgramRecordOutcomeIntegrity,
  programOutcomeDocLines,
  programOutcomeDocText,
  programRecordOutcomeEntries,
  programRecordOutcomeTexts,
  type ProgramOutcomeDoc,
  type ProgramOutcomeDocNode,
  type ProgramRecord,
} from './program-datasets';

/**
 * Issue #161 — chuyển YCCĐ của dataset GDPT sang Tiptap doc:
 *
 * - Text canonical của một YCCĐ trích từ doc bằng ĐÚNG MỘT hàm
 *   (programOutcomeDocText): id/hash tính trên text này nên đổi
 *   định dạng lưu không được đổi id của cùng một nội dung chữ.
 * - Kiểm chứng toàn vẹn: doc đã tách phải khớp `outcome_text`
 *   nguyên văn (bỏ qua các token gạch đầu dòng là dấu trình bày);
 *   lệch chữ thật là lỗi dataset, không nạp thầm.
 */

const text = (t: string) => ({ type: 'text', text: t });
const paragraph = (t: string): ProgramOutcomeDocNode => ({
  type: 'paragraph',
  content: [text(t)],
});
const simpleDoc = (t: string): ProgramOutcomeDoc => ({ type: 'doc', content: [paragraph(t)] });

function record(partial: Partial<ProgramRecord>): ProgramRecord {
  return {
    id: 'XX-0001',
    subject: 'Môn mẫu',
    grade: 1,
    level: 'Tiểu học',
    stream: null,
    section: null,
    topic: null,
    content: '',
    kind: 'requirement',
    outcomes: [],
    outcome_text: '',
    source: { document: 'Văn bản mẫu', file: 'ct-mau.pdf', portal: '', pdf_pages: [1] },
    ...partial,
  };
}

describe('programOutcomeDocText — hàm trích canonical duy nhất', () => {
  it('doc một paragraph cho đúng nguyên văn của paragraph đó', () => {
    expect(programOutcomeDocText(simpleDoc('Bước đầu biết hát đúng cao độ.'))).toBe(
      'Bước đầu biết hát đúng cao độ.',
    );
  });

  it('doc có ý con: paragraph cha rồi các ý con theo thứ tự tài liệu, lồng sâu đệ quy', () => {
    const doc: ProgramOutcomeDoc = {
      type: 'doc',
      content: [
        paragraph('Nêu được:'),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('Đặc điểm của hệ thống chính trị.')] },
            {
              type: 'listItem',
              content: [
                paragraph('Cấu trúc của hệ thống chính trị:'),
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [paragraph('Đảng Cộng sản Việt Nam.')] },
                    { type: 'listItem', content: [paragraph('Nhà nước.')] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(programOutcomeDocLines(doc)).toEqual([
      'Nêu được:',
      'Đặc điểm của hệ thống chính trị.',
      'Cấu trúc của hệ thống chính trị:',
      'Đảng Cộng sản Việt Nam.',
      'Nhà nước.',
    ]);
    expect(programOutcomeDocText(doc)).toBe(
      'Nêu được:\nĐặc điểm của hệ thống chính trị.\nCấu trúc của hệ thống chính trị:\nĐảng Cộng sản Việt Nam.\nNhà nước.',
    );
  });

  it('bỏ qua marks khi trích text: chữ có marks và chữ trơn cho cùng canonical', () => {
    const marked: ProgramOutcomeDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hàm số ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'y = ax + b', marks: [{ type: 'italic' }] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
    expect(programOutcomeDocText(marked)).toBe('Hàm số y = ax + b.');
  });
});

describe('programRecordOutcomeTexts / programRecordOutcomeEntries với outcomes dạng doc', () => {
  it('mỗi doc cho một dòng canonical; thứ tự giữ nguyên thứ tự outcomes[]', () => {
    const rec = record({
      outcomes: [simpleDoc('Ý một.'), simpleDoc('Ý hai.')],
      outcome_text: '– Ý một. – Ý hai.',
    });
    expect(programRecordOutcomeTexts(rec)).toEqual(['Ý một.', 'Ý hai.']);
  });

  it('đổi định dạng lưu chuỗi → doc KHÔNG đổi id của cùng một nội dung chữ', () => {
    const asString = record({ outcomes: ['Ý một.', 'Ý hai.'], outcome_text: '– Ý một. – Ý hai.' });
    const asDoc = record({
      outcomes: [simpleDoc('Ý một.'), simpleDoc('Ý hai.')],
      outcome_text: '– Ý một. – Ý hai.',
    });
    expect(programRecordOutcomeEntries('mau', asDoc)).toEqual(programRecordOutcomeEntries('mau', asString));
  });

  it('bản ghi hoạt động không có outcomes: đúng một dòng bằng toàn văn outcome_text', () => {
    const rec = record({
      kind: 'activity',
      outcomes: [],
      outcome_text: 'Thực hành ứng dụng các kiến thức vào thực tiễn, chẳng hạn: – Ví dụ một. – Ví dụ hai.',
    });
    expect(programRecordOutcomeTexts(rec)).toEqual([
      'Thực hành ứng dụng các kiến thức vào thực tiễn, chẳng hạn: – Ví dụ một. – Ví dụ hai.',
    ]);
  });

  it('cả outcomes và outcome_text đều rỗng: không có dòng nào', () => {
    expect(programRecordOutcomeTexts(record({ outcomes: [], outcome_text: '' }))).toEqual([]);
  });
});

describe('assertProgramRecordOutcomeIntegrity — cổng toàn vẹn khi nạp', () => {
  it('doc khớp outcome_text (gạch đầu dòng là dấu trình bày, gạch trong ý được giữ): không lỗi', () => {
    const rec = record({
      outcomes: [simpleDoc('Cảm nhận âm thanh cao – thấp.'), simpleDoc('Nêu được tên bản nhạc.')],
      outcome_text: '– Cảm nhận âm thanh cao – thấp. – Nêu được tên bản nhạc.',
    });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).not.toThrow();
  });

  it('doc có ý con khớp outcome_text dùng dấu + cho ý con: không lỗi', () => {
    const rec = record({
      outcomes: [
        {
          type: 'doc',
          content: [
            paragraph('Nêu được:'),
            {
              type: 'bulletList',
              content: [{ type: 'listItem', content: [paragraph('Khái niệm pháp luật.')] }],
            },
          ],
        },
      ],
      outcome_text: '– Nêu được: + Khái niệm pháp luật.',
    });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).not.toThrow();
  });

  it('outcome_text viết dấu gạch dính vào chữ (thiếu khoảng trắng): vẫn khớp, không lỗi', () => {
    const rec = record({
      outcomes: [simpleDoc('Kể được một câu chuyện.'), simpleDoc('Trình bày được ý kiến.')],
      outcome_text: '– Kể được một câu chuyện. –Trình bày được ý kiến.',
    });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).not.toThrow();
  });

  it('danh sách liệt kê ngăn bằng dấu phảy (Tiếng Anh): doc tách từng mục vẫn khớp outcome_text', () => {
    const rec = record({
      outcomes: [simpleDoc('Nguyên âm đơn'), simpleDoc('nguyên âm đôi'), simpleDoc('phụ âm')],
      outcome_text: 'Nguyên âm đơn, nguyên âm đôi, phụ âm',
    });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).not.toThrow();
  });

  it('doc bị rơi chữ so với outcome_text: ném lỗi nêu dataset + bản ghi', () => {
    const rec = record({
      id: 'XX-0007',
      outcomes: [simpleDoc('Ý một.')],
      outcome_text: '– Ý một. – Ý hai bị rơi.',
    });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).toThrow(/XX-0007/);
  });

  it('bản ghi còn ở dạng chuỗi (chưa chuyển đổi): cổng toàn vẹn chưa áp, không lỗi', () => {
    const rec = record({ outcomes: ['Ý một.'], outcome_text: '– Ý một. – Ý hai.' });
    expect(() => assertProgramRecordOutcomeIntegrity('mau', rec)).not.toThrow();
  });
});
