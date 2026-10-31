import { FileText } from 'lucide-react';
import { cn } from '@lms/ui/lib/utils';

/**
 * Thẻ tệp đính kèm theo đúng khuôn của bản demo (issue #608,
 * điểm E19 — chuỗi class trích nguyên văn từ component tin
 * nhắn trong chunk chat của demo): thẻ `rounded-lg` có viền,
 * đệm `px-3 py-2`, biểu tượng tệp 16px, tên tệp `text-xs`
 * đậm vừa 500 cắt gọn, dòng dung lượng `text-[10px]` mờ 70%.
 * Hai biến thể màu theo phía hội thoại như class điều kiện
 * của demo: tin của chính người xem nằm trên nền bong bóng
 * chính nên dùng viền/nền theo `primary-foreground`, tin của
 * người khác dùng viền mặc định trên nền `background`.
 *
 * Đính kèm tệp CHƯA có phán quyết chức năng và chưa có
 * dữ kiện đính kèm ở bất kỳ tầng nào, nên thẻ này hiện mới
 * được dùng ở khối tệp đã chia sẻ của panel thông tin (điểm
 * G9) qua adapter; nhánh tệp trong bong bóng tin sẽ dùng lại
 * đúng component này khi dữ kiện đính kèm được phán quyết và
 * thi công ở đợt backend.
 */
export function FileCard({
  name,
  sizeLabel,
  own = false,
  href,
}: {
  /** Tên tệp hiển thị, cắt gọn khi quá dài. */
  name: string;
  /** Nhãn dung lượng đã định dạng (ví dụ "1.2 MB"); vắng mặt thì không hiện dòng dung lượng. */
  sizeLabel?: string;
  /** Thẻ nằm trong bong bóng tin của chính người xem (biến thể màu trên nền chính). */
  own?: boolean;
  /** Địa chỉ tải tệp; có thì thẻ là liên kết tải xuống như demo, chưa có thì là khối tĩnh cùng hình dạng. */
  href?: string;
}) {
  const className = cn(
    'flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors',
    own
      ? 'border-primary-foreground/20 bg-primary-foreground/10 hover:bg-primary-foreground/15'
      : 'border-border bg-background hover:bg-background/80',
  );
  const content = (
    <>
      <FileText className="size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium">{name}</p>
        {sizeLabel ? <p className="text-[10px] opacity-70">{sizeLabel}</p> : null}
      </div>
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" download={name} className={className}>
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}
