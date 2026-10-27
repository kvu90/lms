import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

/**
 * Interceptor đánh dấu các path alias cũ của cụm messaging/notifications
 * là sắp bỏ (Deprecation + Sunset theo RFC 8594) và ghi log có cấu trúc
 * cho mỗi lượt gọi qua alias.
 *
 * @remarks
 * Vai trò: interceptor này chỉ gắn ở cấp phương thức lên đúng các
 * handler alias của cụm (các handler mang path cũ trong
 * `messaging.controller.ts`) — các handler canonical không gắn
 * interceptor, nên lượt gọi canonical không có header
 * Deprecation/Sunset và không sinh log alias.
 *
 * Cơ chế: khớp phần path của `req.url` (đã bỏ query string) theo bảng
 * mẫu alias dưới đây, thứ tự segment chữ trước tham số (mẫu
 * `bulk-remove` và các mẫu hành động đứng trước mẫu `:id` trần).
 * Khi khớp: gắn header `Deprecation: true` và
 * `Sunset: Sun, 01 Feb 2027 00:00:00 GMT` lên response, đồng thời ghi
 * một bản ghi log có cấu trúc dạng JSON qua `logger.warn` với các
 * trường `event: 'deprecated_route_alias'`, `method`, `alias`,
 * `canonical` và `path` (path cụ thể của lượt gọi, không kèm query
 * string). Mẫu `alias`/`canonical` giữ nguyên tên tham số (`:id`) để
 * log gom nhóm được theo route thay vì theo id cụ thể. Khi không
 * khớp: không gắn header, không ghi log, để handler chạy bình thường.
 *
 * Điều kiện gỡ alias: mỗi lượt gọi alias ghi một bản ghi log có cấu
 * trúc như trên; điều kiện gỡ alias là log ghi nhận 0 lượt gọi alias
 * trong 14 ngày — đó là căn cứ chính để quyết định gỡ. Header Sunset
 * chỉ là hạn ngoài thông báo cho client, không phải căn cứ tự động gỡ
 * alias khi tới hạn mà log vẫn còn lượt gọi.
 */
@Injectable()
export class MessagingDeprecationInterceptor implements NestInterceptor {
  /** Logger ghi bản ghi alias có cấu trúc; khởi tạo inline, interceptor không có dependency inject. */
  private readonly logger = new Logger(MessagingDeprecationInterceptor.name);

  /**
   * Bảng mẫu alias của cụm messaging/notifications: mỗi mẫu sinh một
   * regex khớp path đầy đủ dưới tiền tố `/api/v1`, kèm cặp
   * (alias, canonical) dạng mẫu path để ghi log. Thứ tự: segment chữ
   * trước tham số, mẫu hành động trước mẫu `:id` trần.
   */
  private static readonly aliasTable: { pattern: RegExp; alias: string; canonical: string }[] = [
    {
      pattern: /^\/api\/v1\/messages\/messages\/bulk-remove$/,
      alias: 'messages/messages/bulk-remove',
      canonical: 'messages/bulk-remove',
    },
    {
      pattern: /^\/api\/v1\/messages\/messages\/[^/]+\/recall$/,
      alias: 'messages/messages/:id/recall',
      canonical: 'messages/:id/recall',
    },
    {
      pattern: /^\/api\/v1\/messages\/messages\/[^/]+\/hard-delete$/,
      alias: 'messages/messages/:id/hard-delete',
      canonical: 'messages/:id/hard-delete',
    },
    {
      pattern: /^\/api\/v1\/messages\/messages\/[^/]+$/,
      alias: 'messages/messages/:id',
      canonical: 'messages/:id',
    },
    {
      pattern: /^\/api\/v1\/notifications\/read-all$/,
      alias: 'notifications/read-all',
      canonical: 'notifications/mark-read',
    },
  ];

  /**
   * Chặn lượt gọi: nếu path khớp một mẫu alias thì gắn header
   * Deprecation/Sunset và ghi log có cấu trúc, rồi để handler chạy
   * tiếp như bình thường.
   *
   * @param context - Ngữ cảnh thực thi của Nest, từ đó lấy request/response HTTP.
   * @param next - Handler tiếp theo trong chuỗi xử lý.
   * @returns Luồng kết quả của handler gốc, không biến đổi.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const url = req?.url ?? '';
    // Chỉ khớp trên phần path: bỏ query string để log và regex không dính tham số truy vấn.
    const path = url.split('?')[0] ?? url;
    const match = MessagingDeprecationInterceptor.aliasTable.find((entry) => entry.pattern.test(path));
    if (match) {
      const res = http.getResponse<Response>();
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
