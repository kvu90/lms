/**
 * Sinh hai file đề mẫu cho lát nhập đề từ file (issue #52):
 *   test/fixtures/question-import/de-mau.docx
 *   test/fixtures/question-import/de-mau.pdf
 *
 * Hai file chứa CÙNG một đề (7 câu nguồn → 10 mục chờ duyệt) nhưng dùng
 * các quy ước đánh dấu khác nhau theo đúng khả năng của từng định dạng:
 *  - DOCX: đáp án đúng BÔI ĐẬM (câu 1), GẠCH CHÂN hai đáp án (câu 2),
 *    bảng đáp án cuối file dạng dòng chữ (câu 3, 5) + Ô BẢNG (câu 7).
 *  - PDF: dấu * trước lựa chọn đúng (câu 1, 2), dòng "Đáp án: C" ngay
 *    trong khối (câu 7), bảng đáp án cuối file (câu 3, 5).
 *  - Cả hai: đúng–sai chùm với hậu tố (Đ)/(S) từng ý (câu 4), trả lời
 *    ngắn có đáp án mẫu ở bảng đáp án (câu 5), tự luận (câu 6).
 *
 * Chạy: node scripts/make-question-import-samples.mjs  (từ thư mục apps/api)
 * PDF cần một font TTF hỗ trợ tiếng Việt; script tự tìm DejaVu Sans /
 * Noto Sans ở các đường dẫn font hệ thống phổ biến.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import PDFDocument from 'pdfkit';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'question-import');
mkdirSync(outDir, { recursive: true });

const QUESTIONS = [
  { stem: 'Câu 1: Thủ đô của Pháp là gì?', options: ['A. London', 'B. Paris', 'C. Berlin', 'D. Madrid'] },
  { stem: 'Câu 2: Những số nào sau đây là số nguyên tố?', options: ['A. 2', 'B. 4', 'C. 5', 'D. 9'] },
  { stem: 'Câu 3: Nước sôi ở 100°C tại áp suất chuẩn.', options: ['A. Đúng', 'B. Sai'] },
  {
    stem: 'Câu 4: Cho hàm số y = x^2. Xét các mệnh đề sau:',
    options: [
      'a) Hàm số đồng biến trên khoảng (0; +∞). (Đ)',
      'b) Hàm số nghịch biến trên khoảng (0; +∞). (S)',
      'c) Hàm số đạt cực tiểu tại x = 0. (Đ)',
      'd) Đồ thị hàm số đi qua điểm (1; 2). (S)',
    ],
  },
  { stem: 'Câu 5: Thủ đô của Việt Nam là ____.', options: [] },
  { stem: 'Câu 6: Trình bày các bước khảo sát và vẽ đồ thị hàm số bậc hai.', options: [] },
  { stem: 'Câu 7: Nghiệm của phương trình 2x + 4 = 0 là gì?', options: ['A. x = 4', 'B. x = 2', 'C. x = -2', 'D. x = 0'] },
];

// --- DOCX ---------------------------------------------------------------------

function docxParagraph(text, fmt) {
  const run = { text, bold: fmt === 'bold', underline: fmt === 'underline' ? { type: 'single' } : undefined };
  return new Paragraph({ children: [new TextRun(run)] });
}

async function makeDocx() {
  const children = [
    docxParagraph('ĐỀ KIỂM TRA MẪU — TOÁN 10'),
    docxParagraph('Thời gian làm bài: 45 phút'),
  ];
  for (const q of QUESTIONS) {
    children.push(docxParagraph(q.stem));
    for (const opt of q.options) {
      let fmt;
      if (q.stem.startsWith('Câu 1') && opt.startsWith('B.')) fmt = 'bold';
      if (q.stem.startsWith('Câu 2') && (opt.startsWith('A.') || opt.startsWith('C.'))) fmt = 'underline';
      children.push(docxParagraph(opt, fmt));
    }
  }
  children.push(docxParagraph('ĐÁP ÁN'));
  children.push(docxParagraph('3. A'));
  children.push(docxParagraph('5. Hà Nội'));
  children.push(new Table({
    rows: [new TableRow({
      children: [
        new TableCell({ children: [new Paragraph('7')] }),
        new TableCell({ children: [new Paragraph('C')] }),
      ],
    })],
  }));
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  writeFileSync(join(outDir, 'de-mau.docx'), buffer);
  console.log('de-mau.docx', buffer.length, 'bytes');
}

// --- PDF ----------------------------------------------------------------------

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

function makePdf() {
  const font = FONT_CANDIDATES.find((p) => existsSync(p));
  if (!font) throw new Error(`Không tìm thấy font TTF hỗ trợ tiếng Việt trong: ${FONT_CANDIDATES.join(', ')}`);
  const lines = ['ĐỀ KIỂM TRA MẪU — TOÁN 10', 'Thời gian làm bài: 45 phút'];
  for (const q of QUESTIONS) {
    lines.push(q.stem);
    for (const opt of q.options) {
      let line = opt;
      if (q.stem.startsWith('Câu 1') && opt.startsWith('B.')) line = `*${opt}`;
      if (q.stem.startsWith('Câu 2') && (opt.startsWith('A.') || opt.startsWith('C.'))) line = `*${opt}`;
      lines.push(line);
    }
    if (q.stem.startsWith('Câu 7')) lines.push('Đáp án: C');
  }
  lines.push('ĐÁP ÁN', '3. A', '5. Hà Nội');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      writeFileSync(join(outDir, 'de-mau.pdf'), buffer);
      console.log('de-mau.pdf', buffer.length, 'bytes');
      resolve();
    });
    doc.on('error', reject);
    doc.registerFont('sample', font);
    doc.font('sample').fontSize(12);
    for (const line of lines) doc.text(line, { lineGap: 4 });
    doc.end();
  });
}

await makeDocx();
await makePdf();
