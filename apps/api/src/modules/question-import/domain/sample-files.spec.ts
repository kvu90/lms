import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractDocxLines, extractPdfLines } from './document-text';
import { parseExamDocument, type ParsedImportItem } from './exam-parser';
import { hasBlockingIssues } from './item-validation';

/**
 * Kiểm chứng đầu-cuối của tầng tách câu trên HAI FILE ĐỀ MẪU THẬT
 * (test/fixtures/question-import/, sinh bởi
 * scripts/make-question-import-samples.mjs): cùng một đề, hai định dạng,
 * hai bộ quy ước đánh dấu khác nhau — kết quả tách phải GIỐNG HỆT nhau:
 * 7 câu nguồn → 10 mục (câu đúng–sai chùm nở thành 4 câu truefalse).
 */
const FIXTURE_DIR = join(__dirname, '../../../../test/fixtures/question-import');

function expectCanonicalExam(items: ParsedImportItem[]): void {
  expect(items).toHaveLength(10);
  expect(items.map((i) => i.qtype)).toEqual([
    'multichoice', 'multichoice', 'truefalse',
    'truefalse', 'truefalse', 'truefalse', 'truefalse',
    'shortanswer', 'essay', 'multichoice',
  ]);
  // Câu 1: một đáp án đúng (B).
  expect(items[0]!.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
  expect(items[0]!.payload.options.single).toBe(true);
  // Câu 2: hai đáp án đúng (A, C) chia đều.
  expect(items[1]!.payload.answers.map((a) => a.fraction)).toEqual([0.5, 0, 0.5, 0]);
  expect(items[1]!.payload.options.single).toBe(false);
  // Câu 3: đúng–sai đơn, đáp án ở bảng đáp án.
  expect(items[2]!.payload.truefalseCorrect).toBe(true);
  // Câu 4: chùm đúng–sai Đ/S/Đ/S, mọi câu con mang đề dẫn.
  expect(items.slice(3, 7).map((i) => i.payload.truefalseCorrect)).toEqual([true, false, true, false]);
  for (const sub of items.slice(3, 7)) {
    expect(sub.payload.questionText).toContain('Cho hàm số y = x^2');
  }
  // Câu 5: trả lời ngắn với đáp án mẫu từ bảng đáp án.
  expect(items[7]!.payload.answers).toEqual([{ text: 'Hà Nội', fraction: 1 }]);
  // Câu 6: tự luận.
  expect(items[8]!.payload.answers).toEqual([]);
  // Câu 7: đáp án C.
  expect(items[9]!.payload.answers.map((a) => a.fraction)).toEqual([0, 0, 1, 0]);
  // Toàn bộ đề mẫu sạch: không mục nào bị chặn duyệt.
  for (const item of items) {
    expect(hasBlockingIssues(item.issues), `mục ${item.ordinal} (${item.qtype}) còn lỗi: ${JSON.stringify(item.issues)}`).toBe(false);
  }
}

describe('file đề mẫu (fixtures)', () => {
  it('de-mau.docx tách đúng toàn bộ đề', async () => {
    const lines = await extractDocxLines(readFileSync(join(FIXTURE_DIR, 'de-mau.docx')));
    expectCanonicalExam(parseExamDocument(lines).items);
  });

  it('de-mau.pdf tách đúng toàn bộ đề', async () => {
    const lines = await extractPdfLines(readFileSync(join(FIXTURE_DIR, 'de-mau.pdf')));
    expectCanonicalExam(parseExamDocument(lines).items);
  });
});
