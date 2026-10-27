/**
 * Tiện ích thuần của trang lần ghim đề (tách cấu trúc từ
 * `pages/quiz.tsx` theo đợt A của issue #223): trích text thuần
 * từ tài liệu rich text và chuyển mốc thời gian ISO sang giá trị
 * cho input `datetime-local`. Không phụ thuộc React hay API.
 */
import { extractRichTextPlainText, type RichTextDocument } from '@lms/contracts';

/** Trích text thuần từ tài liệu rich text; tài liệu trống/thiếu thì trả chuỗi rỗng. */
export function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/** Chuyển giá trị Date của API sang giá trị cho input datetime-local. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
