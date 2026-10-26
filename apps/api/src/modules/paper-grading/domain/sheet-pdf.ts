/**
 * Sinh PDF phiếu trả lời CAM-0 (issue #112) bằng pdf-lib: vẽ vector đúng
 * hình học template của `sheet-layout.ts` (MỘT nguồn sự thật cho PDF +
 * ảnh mô phỏng + engine OMR). Mỗi trang là một phiếu A4: 4 fiducial,
 * QR (phiếu cá nhân hoá mang userId; phiếu dùng chung chỉ mang mã lô +
 * mã đề), vùng mã (phiếu dùng chung in lưới ô tô mã học sinh + vùng
 * ghi/tô mã đề; phiếu cá nhân hoá in sẵn tên + mã), lưới đáp án theo
 * layout đã ghim của lô. Font DejaVu đã vendor trong `assets/` để chữ
 * tiếng Việt in đúng dấu trên máy in trường học thông thường.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import type { PaperSlotLayout } from '@lms/contracts';
import {
  ANSWER_TOP, CODE_BUBBLE_R, CODE_ORIGIN, FIDUCIAL_CENTERS, FIDUCIAL_SIZE, OPTION_LETTERS,
  PX_PER_PT, QR_RECT, TEMPLATE_HEIGHT, TEMPLATE_WIDTH, VARIANT_ORIGIN, VARIANT_WRITE_BOX,
  computeSheetGeometry,
} from './sheet-layout';

/**
 * Tiền tố payload QR trên phiếu: `LMSQ1|<batchId>|<lotCode>|<userId|''>`.
 * lotCode là mã định danh của lô in: mã đề 4 số (examCode) với lô có
 * mã đề số, ngược lại là variantCode. Phiếu DÙNG CHUNG không bao giờ
 * mang userId — QR của phiếu chung chỉ định danh buổi/variant (lớp dự
 * phòng định tuyến khi lưới tô mã đề không đọc được), định danh học
 * sinh luôn đi qua lưới ô tô mã + roster.
 */
export const SHEET_QR_PREFIX = 'LMSQ1';

export function sheetQrPayload(batchId: string, variantCode: string, userId: string | null): string {
  return `${SHEET_QR_PREFIX}|${batchId}|${variantCode}|${userId ?? ''}`;
}

/** Giải payload QR đọc được trên phiếu; null khi không phải QR phiếu của hệ thống. */
export function parseSheetQr(text: string | null): { batchId: string; variantCode: string; userId: string | null } | null {
  if (!text) return null;
  const parts = text.split('|');
  if (parts.length !== 4 || parts[0] !== SHEET_QR_PREFIX || !parts[1] || !parts[2]) return null;
  return { batchId: parts[1]!, variantCode: parts[2]!, userId: parts[3] ? parts[3]! : null };
}

const PAGE_W_PT = TEMPLATE_WIDTH / PX_PER_PT;
const PAGE_H_PT = TEMPLATE_HEIGHT / PX_PER_PT;
const INK = rgb(0.08, 0.08, 0.08);
const GRAY = rgb(0.45, 0.45, 0.45);
const LETTER_INK = rgb(0.62, 0.62, 0.62);

let fontCache: { regular: Buffer; bold: Buffer } | null = null;
function loadFonts(): { regular: Buffer; bold: Buffer } {
  if (fontCache) return fontCache;
  const dir = path.join(__dirname, '..', 'assets');
  const regular = readFileSync(path.join(dir, 'DejaVuSans.ttf'));
  const bold = readFileSync(path.join(dir, 'DejaVuSans-Bold.ttf'));
  if (!existsSync(path.join(dir, 'DejaVuSans.ttf'))) throw new Error('DejaVuSans.ttf missing from paper-grading assets');
  fontCache = { regular, bold };
  return fontCache;
}

const px = (v: number) => v / PX_PER_PT;
/** Đổi toạ độ template (y từ trên xuống) sang baseline PDF (y từ dưới lên) cho một dòng chữ có đỉnh tại yPx. */
const topToBaseline = (yPx: number, sizePt: number) => PAGE_H_PT - px(yPx) - sizePt * 0.82;

interface Ctx {
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
}

function text(page: PDFPage, ctx: Ctx, s: string, xPx: number, yTopPx: number, sizePt: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; maxWidthPt?: number } = {}): void {
  const font = opts.bold ? ctx.bold : ctx.regular;
  let out = s;
  if (opts.maxWidthPt) {
    while (out.length > 1 && font.widthOfTextAtSize(out, sizePt) > opts.maxWidthPt) out = out.slice(0, -2);
    if (out !== s) out = `${out.trimEnd()}…`;
  }
  page.drawText(out, { x: px(xPx), y: topToBaseline(yTopPx, sizePt), size: sizePt, font, color: opts.color ?? INK });
}

function rect(page: PDFPage, xPx: number, yPx: number, wPx: number, hPx: number, color: ReturnType<typeof rgb>): void {
  page.drawRectangle({ x: px(xPx), y: PAGE_H_PT - px(yPx + hPx), width: px(wPx), height: px(hPx), color });
}

function outlineRect(page: PDFPage, xPx: number, yPx: number, wPx: number, hPx: number): void {
  page.drawRectangle({
    x: px(xPx), y: PAGE_H_PT - px(yPx + hPx), width: px(wPx), height: px(hPx),
    borderColor: INK, borderWidth: 1.1,
  });
}

function bubble(page: PDFPage, cxPx: number, cyPx: number, rPx: number, letter: string, ctx: Ctx): void {
  page.drawCircle({ x: px(cxPx), y: PAGE_H_PT - px(cyPx), size: px(rPx), borderColor: INK, borderWidth: 1.1 });
  if (letter) {
    const sizePt = 8.5;
    const w = ctx.regular.widthOfTextAtSize(letter, sizePt);
    page.drawText(letter, {
      x: px(cxPx) - w / 2, y: PAGE_H_PT - px(cyPx) - sizePt * 0.36,
      size: sizePt, font: ctx.regular, color: LETTER_INK,
    });
  }
}

function drawQr(page: PDFPage, payload: string): void {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const cell = QR_RECT.size / (size + 4); // quiet zone 2 module mỗi phía, khớp bộ dựng mô phỏng
  rect(page, QR_RECT.x - 4, QR_RECT.y - 4, QR_RECT.size + 8, QR_RECT.size + 8, rgb(1, 1, 1));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (qr.modules.data[r * size + c]) {
        rect(page, QR_RECT.x + (c + 2) * cell, QR_RECT.y + (r + 2) * cell, Math.ceil(cell), Math.ceil(cell), INK);
      }
    }
  }
}

export interface SheetPageStudent { userId: string; displayName: string; code: string }

export interface SheetsPdfInput {
  quizName: string;
  variantCode: string;
  /** Mã đề 4 số của lô (null với lô chưa có mã đề số) — QR của phiếu dùng chung mang mã này thay cho variantCode. */
  examCode: string | null;
  /** Số cột lưới mã học sinh của lô: 4 (tại lớp) hoặc 8 (thi thử SBD). */
  codeDigits: number;
  batchId: string;
  layout: PaperSlotLayout[];
  /** Một phần tử cho mỗi trang: học sinh (phiếu cá nhân hoá) hoặc null (phiếu dùng chung). */
  pages: (SheetPageStudent | null)[];
}

/** Dựng PDF nhiều trang (mỗi trang một phiếu) từ layout đã ghim của lô. */
export async function generateSheetsPdf(input: SheetsPdfInput): Promise<Buffer> {
  const fonts = loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts.regular, { subset: true });
  const bold = await doc.embedFont(fonts.bold, { subset: true });
  const ctx: Ctx = { doc, regular, bold };
  const geometry = computeSheetGeometry(input.layout.map((l) => l.optionCount), input.codeDigits);

  for (const student of input.pages) {
    const page = doc.addPage([PAGE_W_PT, PAGE_H_PT]);
    // Fiducial 4 góc.
    for (const c of FIDUCIAL_CENTERS) {
      rect(page, c.x - FIDUCIAL_SIZE / 2, c.y - FIDUCIAL_SIZE / 2, FIDUCIAL_SIZE, FIDUCIAL_SIZE, INK);
    }
    // Đầu phiếu.
    text(page, ctx, 'PHIẾU TRẢ LỜI TRẮC NGHIỆM', 150, 54, 16, { bold: true });
    text(page, ctx, input.quizName, 150, 88, 12.5, { maxWidthPt: px(QR_RECT.x - 150 - 14) });
    if (student) {
      text(page, ctx, `Mã đề: ${input.variantCode}`, 150, 118, 11, { bold: true });
      drawQr(page, sheetQrPayload(input.batchId, input.variantCode, student.userId));
    } else {
      // Phiếu dùng chung KHÔNG in sẵn mã đề: em ghi + tô mã đề theo đề thi được phát.
      text(page, ctx, 'Mã đề: ghi và tô ở vùng MÃ ĐỀ bên dưới, theo đề thi em nhận.', 150, 118, 11, { bold: true });
      drawQr(page, sheetQrPayload(input.batchId, input.examCode ?? input.variantCode, null));
    }

    // Vùng học sinh (y 150..300).
    if (student) {
      text(page, ctx, `Họ và tên: ${student.displayName}`, 64, 168, 12, { bold: true, maxWidthPt: px(QR_RECT.x - 64 - 14) });
      text(page, ctx, `Mã học sinh: ${student.code} — phiếu này chỉ dành cho học sinh trên, không dùng chung.`, 64, 202, 10.5, { color: GRAY });
    } else {
      text(page, ctx, 'Họ và tên: …………………………………………………………', 64, 168, 12, { maxWidthPt: px(QR_RECT.x - 64 - 14) });
      text(page, ctx, input.codeDigits === 8
        ? 'Tô kín SỐ BÁO DANH 8 số của em vào lưới MÃ HỌC SINH ở dưới (7 số thứ tự + 1 số kiểm tra do giáo viên cấp).'
        : 'Tô kín MÃ HỌC SINH của em vào lưới mã ở dưới (3 số thứ tự + 1 số kiểm tra do giáo viên cấp).', 64, 202, 10.5, { color: GRAY });
    }
    text(page, ctx, 'Hướng dẫn: dùng bút chì 2B hoặc bút bi tô KÍN ô tròn của đáp án em chọn. Mỗi câu chỉ tô MỘT ô.', 64, 246, 9.5, { color: GRAY });
    text(page, ctx, 'Muốn đổi đáp án: xoá thật sạch ô cũ rồi tô ô mới. Không gấp, không làm nhàu phiếu, giữ phiếu phẳng và sạch.', 64, 268, 9.5, { color: GRAY });

    // Vùng mã — chỉ phiếu dùng chung (phiếu cá nhân hoá định danh bằng QR).
    if (!student) {
      // Vùng mã đề: nhãn + hàng ô ghi chữ số + lưới tô 4×10 bên dưới.
      text(page, ctx, 'MÃ ĐỀ', VARIANT_ORIGIN.x, 300, 10, { bold: true });
      const colXs = [...new Set(geometry.variantCodeCells.map((c) => c.x))].sort((a, b) => a - b);
      for (const cx of colXs) {
        outlineRect(page, cx - VARIANT_WRITE_BOX.width / 2, VARIANT_WRITE_BOX.top, VARIANT_WRITE_BOX.width, VARIANT_WRITE_BOX.height);
      }
      for (const cell of geometry.variantCodeCells) {
        bubble(page, cell.x, cell.y, CODE_BUBBLE_R, String(cell.value), ctx);
      }
      // Lưới mã học sinh (4 hoặc 8 cột theo cấu hình lô).
      text(page, ctx, 'MÃ HỌC SINH', CODE_ORIGIN.x, 300, 10, { bold: true });
      for (const cell of geometry.codeCells) {
        bubble(page, cell.x, cell.y, CODE_BUBBLE_R, String(cell.value), ctx);
      }
    }

    // Lưới đáp án.
    text(page, ctx, 'ĐÁP ÁN', 64, ANSWER_TOP - 44, 10, { bold: true });
    for (const row of geometry.rows) {
      const layout = input.layout[row.slot - 1]!;
      text(page, ctx, `${row.slot}.`, row.labelX, row.labelY - 12, 11, { bold: true });
      row.centers.forEach((center, k) => {
        // Câu đúng/sai chùm TF-A: 4 cặp ô Đ/S nối tiếp nhau trên một
        // hàng (cặp của ý k ở hai ô 2k = Đ, 2k+1 = S).
        const letter = layout.qtype === 'truefalse' ? (k % 2 === 0 ? 'Đ' : 'S') : (OPTION_LETTERS[k] ?? '');
        bubble(page, center.x, center.y, 13, letter, ctx);
      });
    }

    // Chân phiếu.
    const footer = `Lô phiếu ${input.batchId.slice(0, 8)} · Mã đề ${input.variantCode} · Phiếu trả lời của hệ thống LMS — chỉ dùng cho bài kiểm tra tương ứng.`;
    const w = regular.widthOfTextAtSize(footer, 8);
    page.drawText(footer, { x: (PAGE_W_PT - w) / 2, y: px(28), size: 8, font: regular, color: GRAY });
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
