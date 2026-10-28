import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

/**
 * Interceptor dùng chung — triển khai DUY NHẤT của khuôn alias
 * đường-cũ cho toàn bộ `apps/api`: đánh dấu các path cũ được giữ lại
 * làm alias sau các đợt chuẩn hoá path là sắp bỏ (Deprecation +
 * Sunset theo RFC 8594) và ghi log có cấu trúc cho mỗi lượt gọi qua
 * alias.
 *
 * @remarks
 * Vai trò: khi một path bị đổi tên hoặc làm phẳng, handler tại path
 * canonical mang path mới, còn path cũ giữ lại dưới dạng handler
 * alias uỷ quyền nguyên vẹn cho cùng logic nghiệp vụ. Interceptor
 * này là điểm duy nhất gắn header cảnh báo và ghi log đo lường cho
 * mọi bề mặt alias; trước đây khuôn này có bốn triển khai song song
 * (bản ở `common/` cho các hành động đổi tên, cùng ba bản theo module
 * cho điểm, cụm đề và messaging) — đợt hợp nhất gom cả bốn về lớp
 * này, các bảng alias trở thành dữ kiện khai theo từng bề mặt ở ngay
 * trong file này.
 *
 * Bốn bề mặt và cách khai bảng của chúng:
 *
 * 1. Hành động đổi tên + làm phẳng path (bảng tĩnh
 *    `actionRenameAliasTable`, 13 mục): các segment hành động đã
 *    chuẩn hoá theo danh sách hành động đóng (issue #345) và cặp
 *    gradebook của phụ huynh sau đợt làm phẳng path (issue #346).
 *    Gắn theo từng handler alias bằng
 *    `@UseInterceptors(DeprecatedRouteAliasInterceptor)` tại các
 *    controller badges, calendar, competencies, content, courses,
 *    exams, guardians, users.
 * 2. Module điểm (bảng tĩnh `gradePathsAliasTable`, 10 mục): các
 *    path cũ họ `courses/:courseId/grades/...` và
 *    `courses/grades/...` (issue #342). Gắn ở cấp lớp trên hai
 *    controller alias trong `legacy-grades.controller.ts`.
 * 3. Cụm đề, bề mặt `exam-papers` (bảng `examPapersAliasTable` SINH
 *    từ 28 hậu tố + 4 ánh xạ canonical ghi đè): toàn bộ bề mặt alias
 *    `exam-papers` nằm ở một controller alias (issue #343). Gắn ở
 *    cấp lớp trên `ExamPapersAliasController`.
 * 4. Messaging/notifications (bảng tĩnh `messagingAliasTable`, 5
 *    mục): các path cũ họ `messages/messages/...` và
 *    `notifications/read-all` (issue #344). Gắn theo từng handler
 *    alias trong `messaging.controller.ts`.
 *
 * Cơ chế: interceptor không phân biệt cách gắn (theo handler hay cấp
 * lớp) — nó chỉ khớp phần path của `req.url` (đã bỏ query string)
 * theo bảng hợp nhất, lấy mục khớp ĐẦU TIÊN. Các khối bảng theo bề
 * mặt không giao nhau về tiền tố path nên thứ tự giữa các khối
 * không ảnh hưởng kết quả khớp; thứ tự TRONG từng bề mặt giữ nguyên
 * như triển khai trước hợp nhất (cụ thể trước tổng quát: segment chữ
 * trước tham số, mẫu dài trước mẫu ngắn) để các ca như
 * `dossiers/mine` hay `:id/dossiers` không bị mẫu tổng quát nuốt.
 * Khi khớp: gắn header `Deprecation: true` và
 * `Sunset: Sun, 01 Feb 2027 00:00:00 GMT` lên response, đồng thời
 * ghi một bản ghi log có cấu trúc dạng JSON qua `logger.warn` với
 * các trường `event: 'deprecated_route_alias'`, `method`, `alias`,
 * `canonical` và `path` (path cụ thể của lượt gọi, không kèm query
 * string). `alias`/`canonical` viết ở dạng mẫu path (tham số giữ
 * nguyên tên `:id`/`:courseId`...) để log gom nhóm được theo route
 * thay vì theo id cụ thể. Khi không khớp: không gắn header, không
 * ghi log, để handler chạy bình thường. Vì interceptor chỉ gắn trên
 * các handler/controller alias, lượt gọi canonical không bao giờ
 * mang header hay sinh log alias.
 *
 * Hai đích xuất file là trường hợp đặc biệt của bảng bề mặt 1:
 * canonical không còn hậu tố file trong path, định dạng chuyển
 * thành dữ liệu yêu cầu (tham số truy vấn `format`); cột `canonical`
 * ghi dạng path đích kèm giá trị `format` tương ứng
 * (`courses/:courseId/progress/reports?format=csv`,
 * `calendar/exports?format=ics`) để log gom nhóm đúng đích.
 *
 * Điểm khác biệt duy nhất so với các triển khai theo module trước
 * hợp nhất: ngữ cảnh logger của bản ghi là tên lớp dùng chung này
 * thay vì tên lớp theo module. Nội dung JSON của bản ghi — thứ mà
 * phép đo điều kiện gỡ alias đọc — giữ nguyên từng ký tự.
 *
 * Điều kiện gỡ alias: mỗi lượt gọi alias ghi một bản ghi log có cấu
 * trúc như trên; điều kiện gỡ alias là log ghi nhận 0 lượt gọi alias
 * trong 14 ngày — đó là căn cứ chính để quyết định gỡ. Header Sunset
 * chỉ là hạn ngoài thông báo cho client, không phải căn cứ tự động
 * gỡ alias khi tới hạn mà log vẫn còn lượt gọi.
 */

/** Giá trị header `Sunset` gắn cho mọi lượt gọi qua alias, dùng chung cho mọi bề mặt. */
const SUNSET_HEADER_VALUE = 'Sun, 01 Feb 2027 00:00:00 GMT';

/**
 * Một mục của bảng alias: `pattern` là regex khớp path đầy đủ của
 * lượt gọi (đã bỏ query string); `alias` và `canonical` là cặp mẫu
 * path ghi vào bản ghi log.
 */
interface DeprecatedRouteAliasEntry {
  pattern: RegExp;
  alias: string;
  canonical: string;
}

/**
 * Bảng bề mặt 1 — hành động đổi tên + làm phẳng path (13 mục, thứ tự
 * cụ thể trước tổng quát). Hai mục đích xuất file mang canonical kèm
 * tham số `format` như mô tả ở đầu file.
 */
const actionRenameAliasTable: DeprecatedRouteAliasEntry[] = [
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
  // Issue #346 (làm phẳng path phụ huynh): path gradebook cũ có 3 cấp
  // tài nguyên nên làm phẳng về 2 cấp.
  { pattern: /^\/api\/v1\/guardian\/students\/[^/]+\/courses\/[^/]+\/gradebook$/, alias: 'guardian/students/:studentId/courses/:courseId/gradebook', canonical: 'guardian/students/:studentId/gradebooks/:courseId' },
];

/**
 * Bảng bề mặt 2 — các path cũ của module điểm (10 mục, thứ tự cụ thể
 * trước tổng quát sau để path dài/đặc thù như xuất vnEdu hay lịch sử
 * điểm khớp đúng cặp của nó thay vì bị cặp tổng quát theo id nuốt
 * trước). `alias` và `canonical` giữ nguyên tên tham số
 * `:courseId`/`:itemId`/`:gradeId`/`:userId`.
 */
const gradePathsAliasTable: DeprecatedRouteAliasEntry[] = [
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
 * Bảng hậu tố của bề mặt 3 (`exam-papers`): `suffix` là phần path
 * sau tiền tố đầy đủ (`exam-papers` cho alias, `exams` cho
 * canonical), dùng chung cho cả hai phía vì hai bề mặt chỉ khác
 * nhau ở tiền tố — trừ bốn hậu tố `board-*` mà bảng ghi đè dưới đây
 * ánh xạ sang `approve`/`reject`. Thứ tự: segment chữ trước tham số,
 * mẫu dài trước mẫu ngắn.
 */
const examPapersSuffixTable: string[] = [
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
 * Ngoại lệ đổi tên của bề mặt 3 (issue #345, giai đoạn 2): bốn hậu
 * tố `board-*` đã hợp nhất vào `approve`/`reject` ở phía canonical
 * `/exams`, nên canonical trong log của alias `/exam-papers` tương
 * ứng cũng là `approve`/`reject` — không còn là hậu tố `board-*`
 * (phía `/exams` nay chỉ giữ `board-*` làm alias đã deprecated của
 * chính nó, thuộc bề mặt 1). Mọi hậu tố còn lại giữ quy tắc chung:
 * canonical là cùng hậu tố dưới tiền tố `/exams`.
 */
const examPapersCanonicalOverride: Record<string, string> = {
  'banks/:bankId/contributions/:contributionId/board-approve': 'banks/:bankId/contributions/:contributionId/approve',
  'banks/:bankId/contributions/:contributionId/board-reject': 'banks/:bankId/contributions/:contributionId/reject',
  'dossiers/:dossierId/board-approve': 'dossiers/:dossierId/approve',
  'dossiers/:dossierId/board-reject': 'dossiers/:dossierId/reject',
};

/**
 * Sinh bảng alias từ bảng hậu tố của một bề mặt có hai tiền tố chỉ
 * khác nhau ở segment đầu (alias `exam-papers`, canonical `exams`):
 * mỗi hậu tố sinh một regex khớp path đầy đủ dưới tiền tố alias
 * (segment tham số `:name` khớp `[^/]+`, segment chữ được thoát ký
 * tự đặc biệt của regex), kèm cặp (alias, canonical) dạng mẫu path
 * để ghi log; canonical của hậu tố có trong `canonicalOverrides`
 * dùng hậu tố ghi đè, còn lại dùng chính hậu tố đó.
 *
 * @param aliasPrefix - Tiền tố của phía alias (ví dụ `exam-papers`).
 * @param canonicalPrefix - Tiền tố của phía canonical (ví dụ `exams`).
 * @param suffixes - Các hậu tố theo đúng thứ tự khớp của bề mặt.
 * @param canonicalOverrides - Ánh xạ hậu tố → hậu tố canonical ghi đè.
 * @returns Bảng alias đã biên dịch, giữ nguyên thứ tự của `suffixes`.
 */
function buildSuffixAliasTable(
  aliasPrefix: string,
  canonicalPrefix: string,
  suffixes: string[],
  canonicalOverrides: Record<string, string>,
): DeprecatedRouteAliasEntry[] {
  return suffixes.map((suffix) => {
    const alias = `${aliasPrefix}/${suffix}`;
    const body = alias
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/');
    return {
      pattern: new RegExp(`^/api/v1/${body}$`),
      alias,
      canonical: `${canonicalPrefix}/${canonicalOverrides[suffix] ?? suffix}`,
    };
  });
}

/** Bảng bề mặt 3 đã biên dịch từ `examPapersSuffixTable` (28 mục). */
const examPapersAliasTable: DeprecatedRouteAliasEntry[] = buildSuffixAliasTable(
  'exam-papers',
  'exams',
  examPapersSuffixTable,
  examPapersCanonicalOverride,
);

/**
 * Bảng bề mặt 4 — các path alias cũ của cụm messaging/notifications
 * (5 mục). Thứ tự: segment chữ trước tham số, mẫu hành động trước
 * mẫu `:id` trần, để `bulk-remove` không bị mẫu `:id` nuốt.
 */
const messagingAliasTable: DeprecatedRouteAliasEntry[] = [
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

@Injectable()
export class DeprecatedRouteAliasInterceptor implements NestInterceptor {
  /** Logger ghi bản ghi alias có cấu trúc; khởi tạo inline, interceptor không có dependency inject. */
  private readonly logger = new Logger(DeprecatedRouteAliasInterceptor.name);

  /**
   * Bảng khớp hợp nhất của cả bốn bề mặt, nối theo khối bề mặt như
   * khai ở đầu file. Các khối không giao nhau về tiền tố path nên
   * thứ tự giữa các khối không ảnh hưởng kết quả khớp; thứ tự trong
   * từng khối là thứ tự khớp của chính bề mặt đó.
   */
  private static readonly aliasTable: DeprecatedRouteAliasEntry[] = [
    ...actionRenameAliasTable,
    ...gradePathsAliasTable,
    ...examPapersAliasTable,
    ...messagingAliasTable,
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
        res.setHeader('Sunset', SUNSET_HEADER_VALUE);
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
