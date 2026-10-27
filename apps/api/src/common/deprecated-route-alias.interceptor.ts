import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Interceptor đánh dấu các path cũ bị đổi tên theo danh sách hành động
 * đóng (issue #345) là sắp bỏ (Deprecation + Sunset theo RFC 8594) và
 * ghi log có cấu trúc cho mỗi lượt gọi qua path cũ (alias).
 *
 * @remarks
 * Vai trò: khi một segment hành động trong path bị đổi sang dạng chuẩn
 * (ví dụ `duplicate` hợp nhất về `copy`, `unsuspend` đổi thành
 * `reactivate`, hậu tố file `.ics`/`.csv` bỏ khỏi path), handler tại
 * path canonical mang segment mới, còn path cũ giữ lại dưới dạng
 * handler alias uỷ quyền nguyên vẹn cho cùng logic nghiệp vụ. Đây là
 * điểm khác với alias của module điểm (issue #342): ở đó alias nằm ở
 * controller riêng; ở đây alias nằm ngay trong controller sở hữu bề
 * mặt, và interceptor này gắn theo từng handler alias bằng
 * `@UseInterceptors(DeprecatedRouteAliasInterceptor)`, dùng chung cho
 * mọi module có path đổi tên.
 *
 * Cơ chế: khớp phần path của `req.url` (đã bỏ query string) theo bảng
 * regex dưới đây, thứ tự cụ thể trước tổng quát sau để path dài/đặc
 * thù khớp đúng cặp alias → canonical của nó. Khi khớp: gắn header
 * `Deprecation: true` và `Sunset: Sun, 01 Feb 2027 00:00:00 GMT` lên
 * response, đồng thời ghi một bản ghi log có cấu trúc dạng JSON qua
 * `logger.warn` với các trường `event: 'deprecated_route_alias'`,
 * `method`, `alias`, `canonical` và `path` (path cụ thể của lượt gọi,
 * không kèm query string). Khi không khớp: không gắn header, không ghi
 * log, để handler chạy bình thường. Vì interceptor chỉ gắn trên các
 * handler alias, lượt gọi canonical không bao giờ mang header hay sinh
 * log alias.
 *
 * Hai đích xuất file là trường hợp đặc biệt của bảng: canonical không
 * còn hậu tố file trong path, định dạng chuyển thành dữ liệu yêu cầu
 * (tham số truy vấn `format`); cột `canonical` ghi dạng path đích kèm
 * giá trị `format` tương ứng để log gom nhóm đúng đích.
 *
 * Điều kiện gỡ alias: mỗi lượt gọi alias ghi một bản ghi log có cấu
 * trúc như trên; điều kiện gỡ alias là log ghi nhận 0 lượt gọi alias
 * trong 14 ngày — đó là căn cứ chính để quyết định gỡ. Header Sunset
 * chỉ là hạn ngoài thông báo cho client, không phải căn cứ tự động gỡ
 * alias khi tới hạn mà log vẫn còn lượt gọi.
 */
@Injectable()
export class DeprecatedRouteAliasInterceptor implements NestInterceptor {
  /** Logger ghi bản ghi alias có cấu trúc; khởi tạo inline, interceptor không có dependency inject. */
  private readonly logger = new Logger(DeprecatedRouteAliasInterceptor.name);

  /**
   * Bảng khớp path cũ → cặp (alias, canonical), cụ thể trước tổng
   * quát sau. `alias` và `canonical` viết ở dạng mẫu path (tham số giữ
   * nguyên tên `:id`/`:sectionId`/`:cmId`/`:courseId`) để log gom
   * nhóm được theo route thay vì theo id cụ thể.
   */
  private static readonly aliasTable: { pattern: RegExp; alias: string; canonical: string }[] = [
    { pattern: /^\/api\/v1\/courses\/[^/]+\/sections\/[^/]+\/duplicate$/, alias: 'courses/:id/sections/:sectionId/duplicate', canonical: 'courses/:id/sections/:sectionId/copy' },
    { pattern: /^\/api\/v1\/courses\/[^/]+\/modules\/[^/]+\/duplicate$/, alias: 'courses/:id/modules/:cmId/duplicate', canonical: 'courses/:id/modules/:cmId/copy' },
    { pattern: /^\/api\/v1\/courses\/[^/]+\/progress\/report\.csv$/, alias: 'courses/:courseId/progress/report.csv', canonical: 'courses/:courseId/progress/reports?format=csv' },
    { pattern: /^\/api\/v1\/courses\/[^/]+\/duplicate$/, alias: 'courses/:id/duplicate', canonical: 'courses/:id/copy' },
    { pattern: /^\/api\/v1\/competencies\/frameworks\/[^/]+\/duplicate$/, alias: 'competencies/frameworks/:id/duplicate', canonical: 'competencies/frameworks/:id/copy' },
    { pattern: /^\/api\/v1\/badges\/[^/]+\/duplicate$/, alias: 'badges/:id/duplicate', canonical: 'badges/:id/copy' },
    { pattern: /^\/api\/v1\/users\/[^/]+\/unsuspend$/, alias: 'users/:id/unsuspend', canonical: 'users/:id/reactivate' },
    { pattern: /^\/api\/v1\/calendar\/export\.ics$/, alias: 'calendar/export.ics', canonical: 'calendar/exports?format=ics' },
    // Giai đoạn 2 (module exams): `board-approve`/`board-reject` hợp nhất vào `approve`/`reject`.
    { pattern: /^\/api\/v1\/exams\/banks\/[^/]+\/contributions\/[^/]+\/board-approve$/, alias: 'exams/banks/:bankId/contributions/:contributionId/board-approve', canonical: 'exams/banks/:bankId/contributions/:contributionId/approve' },
    { pattern: /^\/api\/v1\/exams\/banks\/[^/]+\/contributions\/[^/]+\/board-reject$/, alias: 'exams/banks/:bankId/contributions/:contributionId/board-reject', canonical: 'exams/banks/:bankId/contributions/:contributionId/reject' },
    { pattern: /^\/api\/v1\/exams\/dossiers\/[^/]+\/board-approve$/, alias: 'exams/dossiers/:dossierId/board-approve', canonical: 'exams/dossiers/:dossierId/approve' },
    { pattern: /^\/api\/v1\/exams\/dossiers\/[^/]+\/board-reject$/, alias: 'exams/dossiers/:dossierId/board-reject', canonical: 'exams/dossiers/:dossierId/reject' },
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
    const match = DeprecatedRouteAliasInterceptor.aliasTable.find((entry) => entry.pattern.test(path));
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
