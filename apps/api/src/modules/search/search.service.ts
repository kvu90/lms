import { Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { sql, type SqlBool } from '@lms/db';
import { SearchRepository, type SearchDocRow } from '@lms/db/repositories/search';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';

/** Một Search Area đăng ký vào registry: biết cách lấy tài liệu gốc để indexer lập chỉ mục và để re-check. */
export interface SearchArea {
  name: string;
  /**
   * Trả về tài liệu của một item, hoặc null nếu item không còn/không nên index.
   *
   * @remarks
   * Trường `content` là nội dung CÔNG KHAI của tài liệu: nó được ghi vào
   * chỉ mục `search_documents` và là căn cứ khớp của engine, nên tuyệt đối
   * không chứa dữ kiện chỉ dành cho người tìm có quyền (ví dụ email).
   * Area nào có thêm nội dung đặc quyền thì khai ở `privilegedContent` —
   * trường đó KHÔNG bao giờ vào chỉ mục; nó chỉ được dùng tại thời điểm
   * truy vấn cho người tìm có quyền quản trị đối tượng của area (xem
   * {@link SearchService.search}).
   */
  fetch(itemId: string): Promise<{ title: string; content: string; contextId: string; ownerId?: string; privilegedContent?: string } | null>;
  /** Liệt kê mọi itemId hiện có của area (dùng cho reindex toàn bộ). */
  listIds(): Promise<string[]>;
  /**
   * Cổng audience theo TỪNG NGƯỜI TÌM (tuỳ chọn): capability tại context
   * của tài liệu không diễn đạt được audience riêng của item — area nào
   * có audience riêng phải khai hàm này để search re-check theo viewer
   * (issue #48).
   */
  audienceCheck?(itemId: string, userId: string): Promise<boolean>;
}

/** PORT của search engine — bản thật là PostgresSearchEngine bên dưới. */
export const SEARCH_ENGINE = Symbol('SEARCH_ENGINE');
export interface SearchEngine {
  query(q: string): Promise<SearchDocRow[]>;
}

/** Adapter Postgres thật: tsvector trên search_documents. */
@Injectable()
export class PostgresSearchEngine implements SearchEngine {
  constructor(private readonly repo: SearchRepository) {}
  async query(q: string): Promise<SearchDocRow[]> { return this.repo.queryEngine(q); }
}

/**
 * Facade của SearchModule (Moodle core_search, §2#17).
 * Bất biến: kết quả PHẢI lọc theo quyền của người tìm TẠI THỜI ĐIỂM TRUY VẤN
 * qua PermissionEvaluator, và re-check lần cuối khi trả kết quả — kể cả khi
 * index còn sót tài liệu (index stale không bao giờ được rò ra ngoài).
 * Tài liệu của user/course bị suspended/deleted phải rời index.
 * Bất biến riêng của area `users`: email là dữ kiện đặc quyền — nó không
 * nằm trong nội dung lập chỉ mục, và cả hai mặt (payload trả về lẫn khả
 * năng khớp theo email) chỉ mở cho người tìm có quyền quản trị người
 * dùng; xem {@link SearchService.canManageUsers} và {@link SearchService.search}.
 */
@Injectable()
export class SearchService {
  private readonly areas = new Map<string, SearchArea>();

  constructor(
    private readonly repo: SearchRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
  ) {
    this.registerBuiltinAreas();
  }

  /** Đăng ký area — các module khác đăng ký qua đây, không sửa service. */
  registerArea(area: SearchArea): void { this.areas.set(area.name, area); }
  listAreas(): string[] { return [...this.areas.keys()]; }

  private registerBuiltinAreas(): void {
    const db = this.repo.dbHandle;
    // Area: courses — tiêu đề + summary của khoá, context là course context.
    this.registerArea({
      name: 'courses',
      fetch: async (itemId) => {
        const c = await db
          .selectFrom('course')
          .select(['id', 'visible', 'full_name as fullName', 'short_name as shortName', 'summary'])
          .where('id', '=', itemId)
          .executeTakeFirst();
        if (!c || !c.visible) return null;
        const ctx = await this.contexts.getByLevelInstance(50, itemId);
        if (!ctx) return null;
        return { title: c.fullName, content: `${c.shortName} ${c.summary}`, contextId: ctx.id };
      },
      // Chỉ lấy cột id: tập id phải y hệt liệt kê toàn bộ khoá (kể cả
      // khoá đang ẩn) — khâu fetch mới quyết định item có vào chỉ mục
      // hay không, listIds không tự lọc thêm điều kiện nào.
      listIds: async () => (await db.selectFrom('course').select('id').execute()).map((r) => r.id),
    });
    // Area: users — hồ sơ công khai; user suspended/deleted không được index.
    // Nội dung công khai đem lập chỉ mục chỉ gồm username (họ tên nằm ở
    // title): người tìm nào cũng tìm được theo họ tên/username như trước.
    // Email KHÔNG vào nội dung lập chỉ mục nữa — nó là nội dung đặc quyền
    // (`privilegedContent`, giữ đúng định dạng "username email" của payload
    // cũ): engine không khớp theo email trong chỉ mục, và email chỉ xuất
    // hiện trong payload của người tìm có quyền quản trị người dùng tại
    // thời điểm truy vấn (xem SearchService.search). Nhờ vậy việc dựng lại
    // chỉ mục toàn bộ không thể đưa email trở lại phía người không có
    // quyền, và tài liệu cũ còn sót trong index cũng bị cắt ở tầng truy vấn.
    this.registerArea({
      name: 'users',
      fetch: async (itemId) => {
        const u = await db
          .selectFrom('users')
          .select(['id', 'suspended', 'deleted', 'is_guest as isGuest', 'first_name as firstName', 'last_name as lastName', 'username', 'email'])
          .where('id', '=', itemId)
          .executeTakeFirst();
        if (!u || u.suspended || u.deleted || u.isGuest) return null;
        const ctx = await this.contexts.getByLevelInstance(30, itemId);
        const sys = ctx ?? (await this.contexts.ensureSystemContext());
        return { title: `${u.firstName} ${u.lastName}`.trim() || u.username, content: u.username, contextId: sys.id, ownerId: u.id, privilegedContent: `${u.username} ${u.email}` };
      },
      // Chỉ lấy cột id của user chưa suspended/chưa deleted, lọc
      // ngay ở WHERE — cùng tập id với cách lọc ở tầng ứng dụng trước
      // đây (hai cột đều boolean NOT NULL nên điều kiện tương đương).
      listIds: async () => (await db.selectFrom('users').select('id')
        .where('suspended', '=', false).where('deleted', '=', false).execute()).map((r) => r.id),
    });
    // Area: contentbank — chỉ nội dung public mới vào index.
    this.registerArea({
      name: 'contentbank',
      fetch: async (itemId) => {
        const c = await db
          .selectFrom('content_bank_content')
          .select(['id', 'visibility', 'name', 'content_type as contentType', 'context_id as contextId', 'creator_id as creatorId'])
          .where('id', '=', itemId)
          .executeTakeFirst();
        if (!c || c.visibility !== 'public') return null;
        return { title: c.name, content: `${c.name} ${c.contentType}`, contextId: c.contextId, ownerId: c.creatorId };
      },
      // Chỉ lấy cột id của nội dung public, lọc ngay ở WHERE — cùng
      // tập id với cách lọc ở tầng ứng dụng trước đây.
      listIds: async () => (await db.selectFrom('content_bank_content').select('id')
        .where('visibility', '=', 'public').execute()).map((r) => r.id),
    });
  }

  /** Lập chỉ mục một item: fetch từ area; null ⇒ gỡ khỏi index. */
  async indexItem(area: string, itemId: string): Promise<boolean> {
    const provider = this.areas.get(area);
    if (!provider) return false;
    const doc = await provider.fetch(itemId);
    if (!doc) { await this.repo.remove(area, itemId); return false; }
    await this.repo.upsert({ area, itemId, title: doc.title, content: doc.content, contextId: doc.contextId, ownerId: doc.ownerId ?? null });
    return true;
  }

  /** Reindex toàn bộ các area đã đăng ký (job nền gọi lại logic này). */
  async reindexAll(): Promise<{ indexed: number }> {
    let indexed = 0;
    for (const [name, provider] of this.areas) {
      for (const id of await provider.listIds()) if (await this.indexItem(name, id)) indexed++;
    }
    return { indexed };
  }

  /** Gỡ mọi tài liệu thuộc về một user (suspended/deleted) khỏi index. */
  async purgeOwner(ownerId: string): Promise<void> { await this.repo.removeByOwner(ownerId); }

  /** Indexer nghe sự kiện miền qua EventEmitter/outbox relay trong process. */
  @OnEvent('course_created')
  async onCourseCreated(p: { courseId?: string }): Promise<void> { if (p.courseId) await this.indexItem('courses', p.courseId); }
  @OnEvent('user_suspended')
  async onUserSuspended(p: { userId?: string }): Promise<void> { if (p.userId) await this.purgeOwner(p.userId); }
  @OnEvent('user_deleted')
  async onUserDeleted(p: { userId?: string }): Promise<void> { if (p.userId) await this.purgeOwner(p.userId); }

  /**
   * Người tìm có quyền quản trị người dùng hay không — định nghĩa dùng
   * cho quy tắc lộ email của area `users`: quản trị toàn site, hoặc giữ
   * capability `user:update` tại context hệ thống. Đây là đúng định
   * nghĩa phía web đã dùng cho cùng bề mặt tìm kiếm (biến `canManageUsers`
   * của bảng lệnh) và khớp họ capability gác các bề mặt quản trị tài
   * khoản (`user:create`/`user:update`/`user:delete` trong UsersController).
   * `user:viewdetails` KHÔNG dùng được cho mục đích này: registry cho
   * gần như mọi archetype quyền mặc định ở capability đó, nên nó không
   * phân biệt được ai có quyền quản trị người dùng.
   *
   * @param userId - Id người tìm.
   * @returns `true` khi người tìm là quản trị toàn site hoặc có
   *   `user:update` tại context hệ thống.
   */
  private async canManageUsers(userId: string): Promise<boolean> {
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const system = await this.contexts.ensureSystemContext();
    return this.evaluator.hasCapability(userId, 'user:update', system.id);
  }

  /**
   * Bổ sung ứng viên area `users` khớp theo địa chỉ email đầy đủ — chỉ
   * gọi khi người tìm có quyền quản trị người dùng. Email không còn nằm
   * trong chỉ mục nên engine không tự khớp được; đường bổ sung này tra
   * trực tiếp bảng `users` theo từng token có chứa `@` trong truy vấn
   * (khớp đúng toàn bộ địa chỉ, không phân biệt hoa thường — đúng phạm
   * vi khớp email của engine trước đây) rồi lấy hàng tài liệu đã lập chỉ
   * mục của người dùng đó để đưa qua cùng pipeline lọc quyền như ứng
   * viên của engine. Người dùng chưa có tài liệu trong chỉ mục thì bỏ
   * qua: tìm kiếm chỉ trả tài liệu đã lập chỉ mục như hiện hành.
   *
   * @param q - Chuỗi truy vấn thô của người tìm.
   * @param candidates - Ứng viên engine đã có (để khử trùng lặp).
   * @returns Danh sách ứng viên đã gộp, giữ thứ tự engine trước, bổ sung sau.
   */
  private async addEmailCandidates(q: string, candidates: SearchDocRow[]): Promise<SearchDocRow[]> {
    const tokens = q.split(/\s+/).filter((token) => token.includes('@'));
    if (!tokens.length) return candidates;
    const seen = new Set(candidates.map((d) => `${d.area}:${d.itemId}`));
    const extra: SearchDocRow[] = [];
    const db = this.repo.dbHandle;
    for (const token of tokens) {
      const rows = await db
        .selectFrom('users')
        .select(['id', 'suspended', 'deleted', 'is_guest as isGuest'])
        .where(sql<SqlBool>`lower(email) = ${token.toLowerCase()}`)
        .execute();
      for (const u of rows) {
        if (u.suspended || u.deleted || u.isGuest) continue;
        const key = `users:${u.id}`;
        if (seen.has(key)) continue;
        const doc = await this.repo.get('users', u.id);
        if (!doc) continue;
        seen.add(key);
        extra.push(doc);
      }
    }
    return [...candidates, ...extra];
  }

  /**
   * Tìm kiếm toàn cục cho một user: engine trả ứng viên, sau đó lọc bằng
   * PermissionEvaluator tại thời điểm truy vấn (course:view ở context
   * của tài liệu) và RE-CHECK bằng cách fetch lại bản ghi gốc qua area —
   * tài liệu gốc đã suspended/deleted/ẩn thì bị loại dù index còn sót.
   *
   * Quy tắc email của area `users` áp ngay trong luồng này: quyền quản
   * trị người dùng của người tìm được tính một lần (xem
   * {@link SearchService.canManageUsers}). Người có quyền giữ hành vi cũ
   * — payload mang nội dung đặc quyền (gồm email) và được bổ sung ứng
   * viên khớp theo email đầy đủ. Người không có quyền chỉ nhận tài liệu
   * mà truy vấn khớp trên nội dung CÔNG KHAI hiện hành của bản ghi gốc,
   * và payload được định hình lại từ chính nội dung công khai đó — kể cả
   * khi hàng trong chỉ mục là tài liệu cũ còn chứa email, email cũng
   * không lọt ra payload và không tạo được kết quả khớp.
   */
  async search(userId: string, q: string): Promise<SearchDocRow[]> {
    const manageUsers = await this.canManageUsers(userId);
    let candidates = await this.repo.queryEngine(q);
    if (manageUsers) candidates = await this.addEmailCandidates(q, candidates);
    const out: SearchDocRow[] = [];
    /** Capability bắt buộc theo từng area — mỗi area khai báo đúng một capability để re-check, không OR nhiều capability. */
    const areaCapability: Record<string, string> = {
      courses: 'course:view',
      users: 'user:viewdetails',
      contentbank: 'contentbank:viewcontent',
    };
    for (const doc of candidates) {
      // Lớp 1: quyền tại thời điểm truy vấn ở context của tài liệu. Một
      // tài liệu sót trong index mà context đã bị xoá (hoặc không còn
      // phân giải được) thì không ai có quyền trên nó — bỏ qua tài liệu
      // đó thay vì để cả truy vấn tìm kiếm sập theo.
      const capability = areaCapability[doc.area] ?? 'course:view';
      let allowed = false;
      try {
        allowed = await this.evaluator.hasCapability(userId, capability, doc.contextId);
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
      }
      if (!allowed) continue;
      // Lớp 2 (re-check): bản ghi gốc còn hợp lệ không?
      const provider = this.areas.get(doc.area);
      if (provider) {
        const fresh = await provider.fetch(doc.itemId);
        if (!fresh) continue;
        if (fresh.contextId !== doc.contextId) continue;
        // Lớp 3 (audience theo viewer): area có audience riêng theo từng
        // item thì phải qua cổng của chính area đó — capability tại
        // context không thay thế được (issue #48).
        if (provider.audienceCheck && !(await provider.audienceCheck(doc.itemId, userId))) continue;
        // Lớp 4 (nội dung đặc quyền — hiện chỉ area `users` với email):
        // tài liệu có `privilegedContent` thì payload và điều kiện khớp
        // đi theo quyền quản trị đối tượng của người tìm. Người có quyền
        // nhận nội dung đặc quyền nguyên vẹn như payload trước đây.
        // Người không có quyền: payload định hình lại từ nội dung công
        // khai của bản ghi gốc, và tài liệu chỉ được giữ khi truy vấn
        // khớp trên chính nội dung công khai đó — chốt chặn này đứng
        // vững cả khi chỉ mục còn sót tài liệu cũ chứa nội dung đặc
        // quyền (engine đã khớp nhờ phần đặc quyền nhưng người tìm
        // không được biết).
        if (fresh.privilegedContent !== undefined) {
          if (manageUsers) {
            out.push({ ...doc, content: fresh.privilegedContent });
            continue;
          }
          if (!(await this.repo.matchesContent(fresh.title, fresh.content, q))) continue;
          out.push({ ...doc, content: fresh.content });
          continue;
        }
      }
      out.push(doc);
    }
    return out;
  }

  /** Chèn thẳng một tài liệu vào index (dùng cho indexer/test khi cần mô phỏng index sót). */
  async indexRaw(v: { area: string; itemId: string; title: string; content: string; contextId: string; ownerId?: string }): Promise<SearchDocRow> {
    return this.repo.upsert(v);
  }
  async removeDoc(area: string, itemId: string): Promise<void> { return this.repo.remove(area, itemId); }
  async listDocs(): Promise<SearchDocRow[]> { return this.repo.listAll(); }
  /** Số tài liệu trong chỉ mục — đếm ở SQL qua repository, không nạp toàn bộ bảng về để lấy độ dài. */
  async countDocs(): Promise<number> { return this.repo.countAll(); }
  /** Truy vấn SQL thô phục vụ chẩn đoán — không dùng trong luồng nghiệp vụ. */
  async ping(): Promise<boolean> { await sql`select 1`.execute(this.repo.dbHandle); return true; }
}
