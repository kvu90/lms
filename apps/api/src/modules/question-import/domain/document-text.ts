import * as mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Tầng trích văn bản của lát nhập đề (issue #52): biến file Word/PDF
 * thành một dòng các "dòng nguồn" (SourceLine) — đơn vị mà bộ tách câu
 * thuần quy tắc làm việc. Mỗi dòng giữ các đoạn định dạng (runs) vì quy
 * ước đánh dấu đáp án phổ biến nhất trong file Word của giáo viên là
 * BÔI ĐẬM / GẠCH CHÂN lựa chọn đúng; PDF không có định dạng nên runs của
 * nó luôn là đoạn thuần (bộ tách dựa vào ký hiệu * và bảng đáp án).
 */
export interface SourceRun {
  text: string;
  bold: boolean;
  underline: boolean;
}

export interface SourceLine {
  text: string;
  runs: SourceRun[];
}

const BLOCK_TAGS = new Set(['p', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'blockquote', 'pre']);
const CELL_TAGS = new Set(['td', 'th']);
const BOLD_TAGS = new Set(['strong', 'b']);
const UNDERLINE_TAGS = new Set(['u']);

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/**
 * Chuyển HTML (đầu ra của mammoth) thành các dòng nguồn: mỗi khối
 * (đoạn, mục danh sách, hàng bảng) là một dòng; riêng ô bảng là một dòng
 * độc lập để bảng đáp án dạng ô đọc được như dãy số/chữ liên tiếp. Trạng
 * thái đậm/gạch chân được theo dõi bằng ngăn xếp thẻ lồng nhau.
 */
export function htmlToSourceLines(html: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let runs: SourceRun[] = [];
  let boldDepth = 0;
  let underlineDepth = 0;

  const flush = () => {
    const text = runs.map((r) => r.text).join('');
    if (text.trim() !== '') {
      // Gộp các run kề nhau cùng định dạng cho gọn, giữ nguyên văn bản.
      const merged: SourceRun[] = [];
      for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last && last.bold === run.bold && last.underline === run.underline) last.text += run.text;
        else merged.push({ ...run });
      }
      lines.push({ text, runs: merged });
    }
    runs = [];
  };

  const tokens = html.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      const text = decodeEntities(token);
      if (text !== '') runs.push({ text, bold: boldDepth > 0, underline: underlineDepth > 0 });
      continue;
    }
    const tagMatch = /^<\/?\s*([a-zA-Z0-9]+)/.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1]!.toLowerCase();
    const closing = token.startsWith('</');
    if (tag === 'br') { flush(); continue; }
    if (BOLD_TAGS.has(tag)) { boldDepth = Math.max(0, boldDepth + (closing ? -1 : 1)); continue; }
    if (UNDERLINE_TAGS.has(tag)) { underlineDepth = Math.max(0, underlineDepth + (closing ? -1 : 1)); continue; }
    if (BLOCK_TAGS.has(tag) || CELL_TAGS.has(tag)) flush();
  }
  flush();
  return lines;
}

/** Trích dòng nguồn từ file .docx (mammoth → HTML → dòng + runs định dạng). */
export async function extractDocxLines(buffer: Buffer): Promise<SourceLine[]> {
  // styleMap "u => u": mammoth mặc định BỎ gạch chân khi sinh HTML; ánh
  // xạ này giữ nó thành thẻ <u> để bộ tách nhận diện đáp án gạch chân.
  const result = await mammoth.convertToHtml({ buffer }, { styleMap: ['u => u'] });
  return htmlToSourceLines(result.value);
}

/** Trích dòng nguồn từ file .pdf (pdf.js qua unpdf; giữ thứ tự trang, không gộp trang). */
export async function extractPdfLines(buffer: Buffer): Promise<SourceLine[]> {
  const proxy = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(proxy, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  const lines: SourceLine[] = [];
  for (const page of pages) {
    for (const raw of page.split(/\r?\n/)) {
      if (raw.trim() === '') continue;
      lines.push({ text: raw, runs: [{ text: raw, bold: false, underline: false }] });
    }
  }
  return lines;
}

export type ImportFileKind = 'docx' | 'pdf';

/**
 * Nhận diện loại file theo chữ ký đầu tệp (magic bytes), dự phòng bằng
 * đuôi tên file: docx là gói zip (PK\x03\x04), pdf bắt đầu bằng %PDF-.
 */
export function detectImportFileKind(buffer: Buffer, fileName: string): ImportFileKind | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'docx';
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  return null;
}
