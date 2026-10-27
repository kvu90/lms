import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

/**
 * Interceptor đánh dấu đường alias cũ `/exam-papers` là sắp bỏ
 * (Deprecation + Sunset theo RFC 8594) và ghi log có cấu trúc cho mỗi
 * lượt gọi qua alias.
 *
 * @remarks
 * Vai trò: toàn bộ bề mặt alias `/exam-papers` của cụm đề nằm ở đúng
 * một controller alias (`ExamPapersAliasController`), và interceptor
 * này chỉ gắn lên controller alias đó — controller canonical
 * `/exams` không gắn interceptor, nên lượt gọi canonical không có
 * header Deprecation/Sunset và không sinh log alias.
 *
 * Cơ chế: khớp phần path của `req.url` (đã bỏ query string) theo bảng
 * mẫu path dưới đây, thứ tự cụ thể trước tổng quát sau (các mẫu bắt
 * đầu bằng segment chữ `banks`/`dossiers` đứng trước các mẫu bắt đầu
 * bằng tham số `:id`, mẫu dài đứng trước mẫu ngắn). Khi khớp: gắn
 * header `Deprecation: true` và
 * `Sunset: Sun, 01 Feb 2027 00:00:00 GMT` lên response, đồng thời ghi
 * một bản ghi log có cấu trúc dạng JSON qua `logger.warn` với các
 * trường `event: 'deprecated_route_alias'`, `method`, `alias`,
 * `canonical` và `path` (path cụ thể của lượt gọi, không kèm query
 * string). Mẫu `alias`/`canonical` giữ nguyên tên tham số
 * (`:bankId`/`:id`/`:dossierId`/`:contributionId`) để log gom nhóm
 * được theo route thay vì theo id cụ thể. Khi không khớp: không gắn
 * header, không ghi log, để handler chạy bình thường.
 *
 * Điều kiện gỡ alias: mỗi lượt gọi alias ghi một bản ghi log có cấu
 * trúc như trên; điều kiện gỡ alias là log ghi nhận 0 lượt gọi alias
 * trong 14 ngày — đó là căn cứ chính để quyết định gỡ. Header Sunset
 * chỉ là hạn ngoài thông báo cho client, không phải căn cứ tự động gỡ
 * alias khi tới hạn mà log vẫn còn lượt gọi.
 */
@Injectable()
export class ExamPapersDeprecationInterceptor implements NestInterceptor {
  /** Logger ghi bản ghi alias có cấu trúc; khởi tạo inline, interceptor không có dependency inject. */
  private readonly logger = new Logger(ExamPapersDeprecationInterceptor.name);

  /**
   * Bảng mẫu path của bề mặt alias: `suffix` là phần path sau tiền tố
   * đầy đủ (`exam-papers` cho alias, `exams` cho canonical), dùng
   * chung cho cả hai phía vì hai bề mặt chỉ khác nhau ở tiền tố —
   * trừ bốn hậu tố `board-*` mà `canonicalOverride` dưới đây ánh xạ
   * sang `approve`/`reject` theo đợt hợp nhất của issue #345.
   * Thứ tự: segment chữ trước tham số, mẫu dài trước mẫu ngắn.
   */
  private static readonly suffixTable: string[] = [
    'banks/:bankId/contributions/:contributionId/board-approve',
    'banks/:bankId/contributions/:contributionId/board-reject',
    'banks/:bankId/contributions/:contributionId/approve',
    'banks/:bankId/contributions/:contributionId/reject',
    'banks/:bankId/contributions',
    'banks/:bankId/dossiers',
    'banks/:bankId/exams',
    'dossiers/mine',
    'dossiers/:dossierId/specification/export',
    'dossiers/:dossierId/specification',
    'dossiers/:dossierId/board-approve',
    'dossiers/:dossierId/board-reject',
    'dossiers/:dossierId/approve',
    'dossiers/:dossierId/reject',
    'dossiers/:dossierId/submit',
    'dossiers/:dossierId',
    ':id/specification/export',
    ':id/specification',
    ':id/dossiers',
    ':id/status',
    ':id/withdraw',
    ':id/restore',
    ':id/copy',
    ':id/swap',
    ':id/pins',
    ':id/print',
    ':id/slots',
    ':id',
  ];

  /**
   * Ngoại lệ đổi tên (issue #345, giai đoạn 2): bốn hậu tố `board-*`
   * đã hợp nhất vào `approve`/`reject` ở phía canonical `/exams`,
   * nên canonical trong log của alias `/exam-papers` tương ứng cũng
   * là `approve`/`reject` — không còn là hậu tố `board-*` (phía
   * `/exams` nay chỉ giữ `board-*` làm alias đã deprecated của
   * chính nó). Mọi hậu tố còn lại giữ quy tắc chung: canonical là
   * cùng hậu tố dưới tiền tố `/exams`.
   */
  private static readonly canonicalOverride: Record<string, string> = {
    'banks/:bankId/contributions/:contributionId/board-approve': 'banks/:bankId/contributions/:contributionId/approve',
    'banks/:bankId/contributions/:contributionId/board-reject': 'banks/:bankId/contributions/:contributionId/reject',
    'dossiers/:dossierId/board-approve': 'dossiers/:dossierId/approve',
    'dossiers/:dossierId/board-reject': 'dossiers/:dossierId/reject',
  };

  /**
   * Bảng khớp đã biên dịch từ `suffixTable`: mỗi mẫu suffix sinh một
   * regex khớp path đầy đủ dưới tiền tố alias `/api/v1/exam-papers`,
   * kèm cặp (alias, canonical) dạng mẫu path để ghi log.
   */
  private static readonly aliasTable: { pattern: RegExp; alias: string; canonical: string }[] =
    ExamPapersDeprecationInterceptor.suffixTable.map((suffix) => {
      const alias = `exam-papers/${suffix}`;
      const body = alias
        .split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
      return {
        pattern: new RegExp(`^/api/v1/${body}$`),
        alias,
        canonical: `exams/${ExamPapersDeprecationInterceptor.canonicalOverride[suffix] ?? suffix}`,
      };
    });

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
    const match = ExamPapersDeprecationInterceptor.aliasTable.find((entry) => entry.pattern.test(path));
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
