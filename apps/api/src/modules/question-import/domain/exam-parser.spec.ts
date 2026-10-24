import { describe, expect, it } from 'vitest';
import { htmlToSourceLines, type SourceLine } from './document-text';
import { parseExamDocument } from './exam-parser';
import { hasBlockingIssues } from './item-validation';

/** Dựng một dòng nguồn thuần (không định dạng — như từ PDF). */
function L(text: string): SourceLine {
  return { text, runs: [{ text, bold: false, underline: false }] };
}
/** Dựng một dòng nguồn mà toàn bộ văn bản mang một định dạng (như từ DOCX). */
function F(text: string, fmt: 'bold' | 'underline'): SourceLine {
  return { text, runs: [{ text, bold: fmt === 'bold', underline: fmt === 'underline' }] };
}

describe('exam parser — trắc nghiệm', () => {
  it('nhận đáp án đúng qua bôi đậm trong docx', () => {
    const { items } = parseExamDocument([
      L('Câu 1: Thủ đô của Pháp là gì?'),
      L('A. London'),
      F('B. Paris', 'bold'),
      L('C. Berlin'),
      L('D. Madrid'),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.qtype).toBe('multichoice');
    expect(item.sourceNumber).toBe(1);
    expect(item.payload.questionText).toBe('Thủ đô của Pháp là gì?');
    expect(item.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
    expect(item.payload.options.single).toBe(true);
    expect(hasBlockingIssues(item.issues)).toBe(false);
  });

  it('hai lựa chọn gạch chân cùng đúng → chọn nhiều, chia đều tỷ trọng', () => {
    const { items } = parseExamDocument([
      L('Câu 2: Những số nào là số nguyên tố?'),
      F('A. 2', 'underline'),
      L('B. 4'),
      F('C. 5', 'underline'),
      L('D. 9'),
    ]);
    const item = items[0]!;
    expect(item.payload.answers.map((a) => a.fraction)).toEqual([0.5, 0, 0.5, 0]);
    expect(item.payload.options.single).toBe(false);
  });

  it('nhiều lựa chọn trên một dòng + dấu * (kiểu pdf)', () => {
    const { items } = parseExamDocument([
      L('Câu 3: Chọn câu đúng. A. Mặt trời mọc ở hướng Tây B. *Mặt trời mọc ở hướng Đông C. Mặt trời lặn ở hướng Đông'),
    ]);
    const item = items[0]!;
    expect(item.qtype).toBe('multichoice');
    expect(item.payload.questionText).toBe('Chọn câu đúng.');
    expect(item.payload.answers.map((a) => a.text)).toEqual([
      'Mặt trời mọc ở hướng Tây', 'Mặt trời mọc ở hướng Đông', 'Mặt trời lặn ở hướng Đông',
    ]);
    expect(item.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0]);
  });

  it('đáp án chỉ có ở bảng đáp án cuối file', () => {
    const { items } = parseExamDocument([
      L('Câu 7: 2 + 2 bằng mấy?'),
      L('A. 3'),
      L('B. 4'),
      L('C. 5'),
      L('D. 6'),
      L('ĐÁP ÁN'),
      L('7. B'),
    ]);
    const item = items[0]!;
    expect(item.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
    expect(hasBlockingIssues(item.issues)).toBe(false);
  });

  it('bảng đáp án dạng ô bảng (số, chữ nối tiếp)', () => {
    const { items } = parseExamDocument([
      L('Câu 1: Màu của bầu trời?'),
      L('A. Đỏ'),
      L('B. Xanh'),
      L('ĐÁP ÁN'),
      L('1'),
      L('B'),
    ]);
    expect(items[0]!.payload.answers.map((a) => a.fraction)).toEqual([0, 1]);
  });

  it('mâu thuẫn giữa bôi đậm và bảng đáp án: bảng đáp án thắng + có warning', () => {
    const { items } = parseExamDocument([
      L('Câu 1: Chọn đáp án đúng.'),
      L('A. Một'),
      F('B. Hai', 'bold'),
      L('C. Ba'),
      L('ĐÁP ÁN'),
      L('1. C'),
    ]);
    const item = items[0]!;
    expect(item.payload.answers.map((a) => a.fraction)).toEqual([0, 0, 1]);
    expect(item.issues.some((i) => i.code === 'answer_source_conflict')).toBe(true);
  });

  it('không có bất kỳ đánh dấu đáp án nào → lỗi chặn duyệt', () => {
    const { items } = parseExamDocument([
      L('Câu 1: Câu hỏi không đánh dấu?'),
      L('A. Một'),
      L('B. Hai'),
    ]);
    expect(items[0]!.issues.some((i) => i.code === 'no_correct_answer' && i.severity === 'error')).toBe(true);
    expect(hasBlockingIssues(items[0]!.issues)).toBe(true);
  });

  it('dãy đáp án gộp trên một dòng "1A 2B" và dòng "Đáp án:" trong khối', () => {
    const { items } = parseExamDocument([
      L('Câu 1: Câu một?'),
      L('A. x'),
      L('B. y'),
      L('Câu 2: Câu hai?'),
      L('A. x'),
      L('B. y'),
      L('Đáp án: B'),
      L('ĐÁP ÁN'),
      L('1A 2A'),
    ]);
    // Câu 1 lấy từ bảng gộp (2A thuộc câu 2 nhưng bảng đáp án ưu tiên hơn gợi ý inline của câu 2? không: câu 2 có cả hai nguồn)
    expect(items[0]!.payload.answers.map((a) => a.fraction)).toEqual([1, 0]);
    expect(items[1]!.payload.answers.map((a) => a.fraction)).toEqual([1, 0]);
    expect(items[1]!.issues.some((i) => i.code === 'answer_source_conflict')).toBe(true);
  });
});

describe('exam parser — đúng/sai', () => {
  it('đúng–sai đơn với hai lựa chọn Đúng/Sai + bảng đáp án', () => {
    const { items } = parseExamDocument([
      L('Câu 3: Nước sôi ở 100 độ C tại áp suất chuẩn.'),
      L('A. Đúng'),
      L('B. Sai'),
      L('ĐÁP ÁN'),
      L('3. A'),
    ]);
    const item = items[0]!;
    expect(item.qtype).toBe('truefalse');
    expect(item.payload.truefalseCorrect).toBe(true);
  });

  it('đúng–sai chùm: mỗi ý thành một câu truefalse mang đề dẫn', () => {
    const { items } = parseExamDocument([
      L('Câu 4: Cho hàm số y = x^2. Xét các mệnh đề sau:'),
      L('a) Hàm số đồng biến trên khoảng (0; +∞). (Đ)'),
      L('b) Hàm số nghịch biến trên khoảng (0; +∞). (S)'),
      L('c) Hàm số đạt cực tiểu tại x = 0. (Đ)'),
      L('d) Đồ thị hàm số đi qua điểm (1; 2). (S)'),
    ]);
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.qtype)).toEqual(['truefalse', 'truefalse', 'truefalse', 'truefalse']);
    expect(items.map((i) => i.payload.truefalseCorrect)).toEqual([true, false, true, false]);
    expect(items[0]!.payload.questionText).toContain('Cho hàm số y = x^2');
    expect(items[0]!.payload.questionText).toContain('đồng biến');
    expect(items[3]!.payload.questionText).toContain('đi qua điểm (1; 2)');
    expect(items.every((i) => !hasBlockingIssues(i.issues))).toBe(true);
  });

  it('đúng–sai chùm với đáp án ý ở bảng đáp án dạng 4a. Đ', () => {
    const { items } = parseExamDocument([
      L('Câu 4: Xét tính đúng sai của các mệnh đề:'),
      L('a) Mệnh đề một.'),
      L('b) Mệnh đề hai.'),
      L('ĐÁP ÁN'),
      L('4a. Đ 4b. S'),
    ]);
    expect(items.map((i) => i.payload.truefalseCorrect)).toEqual([true, false]);
  });

  it('mệnh đề đơn có hậu tố (Sai) → truefalse', () => {
    const { items } = parseExamDocument([
      L('Câu 5: Mọi số nguyên tố đều là số lẻ. (Sai)'),
    ]);
    expect(items[0]!.qtype).toBe('truefalse');
    expect(items[0]!.payload.truefalseCorrect).toBe(false);
    expect(items[0]!.payload.questionText).toBe('Mọi số nguyên tố đều là số lẻ.');
  });
});

describe('exam parser — trả lời ngắn, tự luận, điểm', () => {
  it('trả lời ngắn: chỗ trống + đáp án mẫu trong bảng đáp án', () => {
    const { items } = parseExamDocument([
      L('Câu 5: Thủ đô của Việt Nam là ____.'),
      L('ĐÁP ÁN'),
      L('5. Hà Nội'),
    ]);
    const item = items[0]!;
    expect(item.qtype).toBe('shortanswer');
    expect(item.payload.answers).toEqual([{ text: 'Hà Nội', fraction: 1 }]);
  });

  it('trả lời ngắn: dòng Đáp án inline, nhiều đáp án mẫu ngăn bằng dấu chấm phẩy', () => {
    const { items } = parseExamDocument([
      L('Câu 8: Điền vào chỗ trống: Thủ đô của Việt Nam là ____.'),
      L('Đáp án: Hà Nội; thủ đô Hà Nội'),
    ]);
    const item = items[0]!;
    expect(item.qtype).toBe('shortanswer');
    expect(item.payload.answers.map((a) => a.text)).toEqual(['Hà Nội', 'thủ đô Hà Nội']);
  });

  it('không lựa chọn, không đáp án mẫu → tự luận', () => {
    const { items } = parseExamDocument([
      L('Câu 6: Phân tích nguyên nhân thắng lợi của cách mạng tháng Tám.'),
    ]);
    expect(items[0]!.qtype).toBe('essay');
    expect(items[0]!.payload.answers).toEqual([]);
    expect(hasBlockingIssues(items[0]!.issues)).toBe(false);
  });

  it('đọc điểm từ "(2 điểm)" và làm sạch nội dung câu', () => {
    const { items } = parseExamDocument([
      L('Câu 9 (2 điểm): Trình bày các bước giải phương trình bậc hai.'),
    ]);
    expect(items[0]!.payload.defaultMark).toBe(2);
    expect(items[0]!.payload.questionText).toBe('Trình bày các bước giải phương trình bậc hai.');
  });

  it('chỗ trống nhưng thiếu đáp án mẫu → lỗi chặn duyệt', () => {
    const { items } = parseExamDocument([
      L('Câu 5: Điền vào chỗ trống: 1 + 1 = ____.'),
    ]);
    expect(items[0]!.qtype).toBe('shortanswer');
    expect(items[0]!.issues.some((i) => i.code === 'sa_answer_missing')).toBe(true);
  });
});

describe('exam parser — cấu trúc file', () => {
  it('dự phòng đánh số "1." khi file không dùng "Câu N"', () => {
    const { items } = parseExamDocument([
      L('1. Thủ đô của Pháp?'),
      L('A. London'),
      F('B. Paris', 'bold'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceNumber).toBe(1);
    expect(items[0]!.payload.answers.map((a) => a.fraction)).toEqual([0, 1]);
  });

  it('bỏ qua phần đầu file và cảnh báo trùng nội dung', () => {
    const { items } = parseExamDocument([
      L('ĐỀ KIỂM TRA GIỮA KỲ'),
      L('Thời gian: 45 phút'),
      L('Câu 1: Nội dung trùng lặp?'),
      L('A. Đúng'),
      L('B. Sai'),
      L('Câu 2: Nội dung trùng lặp?'),
      L('A. Đúng'),
      L('B. Sai'),
      L('ĐÁP ÁN'),
      L('1. A 2. B'),
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]!.issues.some((i) => i.code === 'duplicate_question_text')).toBe(true);
  });

  it('file không có câu nào → warnings no_questions_found', () => {
    const { items, warnings } = parseExamDocument([L('Chỉ là một đoạn văn.')]);
    expect(items).toEqual([]);
    expect(warnings.some((w) => w.code === 'no_questions_found')).toBe(true);
  });
});

describe('htmlToSourceLines', () => {
  it('giữ định dạng đậm/gạch chân và tách ô bảng thành dòng riêng', () => {
    const lines = htmlToSourceLines(
      '<p>Câu 1: Chọn <strong>đáp án</strong> đúng</p><p><u>A. Một</u></p>'
      + '<table><tr><td>1</td><td>B</td></tr></table>',
    );
    expect(lines.map((l) => l.text)).toEqual(['Câu 1: Chọn đáp án đúng', 'A. Một', '1', 'B']);
    const strongRun = lines[0]!.runs.find((r) => r.text === 'đáp án');
    expect(strongRun?.bold).toBe(true);
    expect(lines[1]!.runs.every((r) => r.underline)).toBe(true);
  });
});
