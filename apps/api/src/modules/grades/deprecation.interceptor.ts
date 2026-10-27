import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Interceptor đánh dấu các đường dẫn cũ của module điểm là sắp bỏ
 * (Deprecation + Sunset theo RFC 8594) và ghi log có cấu trúc cho mỗi
 * lượt gọi qua đường dẫn cũ (alias).
 *
 * @remarks
 * Vai trò: các handler alias trong `legacy-grades.controller.ts` giữ
 * nguyên các path cũ của module điểm để client cũ vẫn gọi được sau khi
 * module điểm áp chuẩn đường dẫn (issue #342). Interceptor này chỉ gắn
 * lên các controller alias đó, không gắn lên controller canonical —
 * lượt gọi canonical không có header Deprecation/Sunset và không sinh
 * log alias.
 *
 * Cơ chế: khớp phần path của `req.url` (đã bỏ query string) theo bảng
 * regex dưới đây, thứ tự cụ thể trước tổng quát sau để path dài/đặc thù
 * (ví dụ xuất vnEdu, lịch sử điểm) khớp đúng cặp alias → canonical của
 * nó thay vì bị cặp tổng quát (item theo id) nuốt trước. Khi khớp:
 * gắn header `Deprecation: true` và
 * `Sunset: Sun, 01 Feb 2027 00:00:00 GMT` lên response, đồng thời ghi
 * một bản ghi log có cấu trúc dạng JSON qua `logger.warn` với các
 * trường `event: 'deprecated_route_alias'`, `method`, `alias`,
 * `canonical` và `path` (path cụ thể của lượt gọi, không kèm query
 * string). Khi không khớp: không gắn header, không ghi log, để
 * handler chạy bình thường.
 *
 * Điều kiện gỡ alias: mỗi lượt gọi alias ghi một bản ghi log có cấu
 * trúc như trên; điều kiện gỡ alias là log ghi nhận 0 lượt gọi alias
 * trong 14 ngày — đó là căn cứ chính để quyết định gỡ. Header Sunset
 * chỉ là hạn ngoài thông báo cho client, không phải căn cứ tự động gỡ
 * alias khi tới hạn mà log vẫn còn lượt gọi.
 */
@Injectable()
export class GradePathsDeprecationInterceptor implements NestInterceptor {
  /** Logger ghi bản ghi alias có cấu trúc; khởi tạo inline, interceptor không có dependency inject. */
  private readonly logger = new Logger(GradePathsDeprecationInterceptor.name);

  /**
   * Bảng khớp path cũ → cặp (alias, canonical), cụ thể trước tổng
   * quát sau. `alias` và `canonical` viết ở dạng mẫu path (tham số
   * giữ nguyên tên `:courseId`/`:itemId`/`:gradeId`/`:userId`) để log
   * gom nhóm được theo route thay vì theo id cụ thể.
   */
  private static readonly aliasTable: { pattern: RegExp; alias: string; canonical: string }[] = [
    { pattern: /^\/api\/v1\/courses\/[^/]+\/grades\/export\/vnedu$/, alias: 'courses/:courseId/grades/export/vnedu', canonical: 'courses/:courseId/grade-exports' },
    { pattern: /^\/api\/v1\/courses\/[^/]+\/grades\/items$/, alias: 'courses/:courseId/grades/items', canonical: 'courses/:courseId/grade-items' },
    { pattern: /^\/api\/v1\/courses\/[^/]+\/grades\/report$/, alias: 'courses/:courseId/grades/report', canonical: 'courses/:courseId/gradebook/report' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+\/users\/[^/]+\/history$/, alias: 'courses/grades/items/:itemId/users/:userId/history', canonical: 'grade-items/:itemId/users/:userId/history' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+\/grades$/, alias: 'courses/grades/items/:itemId/grades', canonical: 'grade-items/:itemId/grades' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+\/posting-policy$/, alias: 'courses/grades/items/:itemId/posting-policy', canonical: 'grade-items/:itemId/posting-policy' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+\/publish$/, alias: 'courses/grades/items/:itemId/publish', canonical: 'grade-items/:itemId/publish' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+\/unpublish$/, alias: 'courses/grades/items/:itemId/unpublish', canonical: 'grade-items/:itemId/unpublish' },
    { pattern: /^\/api\/v1\/courses\/grades\/items\/[^/]+$/, alias: 'courses/grades/items/:itemId', canonical: 'grade-items/:itemId' },
    { pattern: /^\/api\/v1\/courses\/grades\/grades\/[^/]+$/, alias: 'courses/grades/grades/:gradeId', canonical: 'grades/:gradeId' },
  ];

  /**
   * Chặn lượt gọi: nếu path khớp một alias thì gắn header
   * Deprecation/Sunset và ghi log có cấu trúc, rồi để handler chạy
   * tiếp như bình thường.
   *
   * @param context - Ngữ cảnh thực thi của Nest, từ đó lấy request/response HTTP.
   * @param next - Handler tiếp theo trong chuỗi xử lý.
   * @returns Luồng kết quả của handler gốc, không biến đổi.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<{ url?: string; method?: string }>();
    const url = req?.url ?? '';
    // Chỉ khớp trên phần path: bỏ query string để log và regex không dính tham số truy vấn.
    const path = url.split('?')[0] ?? url;
    const match = GradePathsDeprecationInterceptor.aliasTable.find((entry) => entry.pattern.test(path));
    if (match) {
      const res = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Sunset', 'Sun, 01 Feb 2027 00:00:00 GMT');
      }
      this.logger.warn(JSON.stringify({
        event: 'deprecated_route_alias',
        method: req?.method,
        alias: match.alias,
        canonical: match.canonical,
        path,
      }));
    }
    return next.handle();
  }
}
