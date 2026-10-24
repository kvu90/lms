import { Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq, sql } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { SearchRepository, type SearchDocRow } from './search.repository';
import { blogPosts, contentBankContent, course, users } from '../../db/schema';

/** Một Search Area đăng ký vào registry: biết cách lấy tài liệu gốc để indexer lập chỉ mục và để re-check. */
export interface SearchArea {
  name: string;
  /** Trả về tài liệu của một item, hoặc null nếu item không còn/không nên index. */
  fetch(itemId: string): Promise<{ title: string; content: string; contextId: string; ownerId?: string } | null>;
  /** Liệt kê mọi itemId hiện có của area (dùng cho reindex toàn bộ). */
  listIds(): Promise<string[]>;
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
 * SearchModule facade (Moodle core_search, §2#17).
 * Bất biến: kết quả PHẢI lọc theo quyền của người tìm TẠI THỜI ĐIỂM TRUY VẤN
 * qua PermissionEvaluator, và re-check lần cuối khi trả kết quả — kể cả khi
 * index còn sót tài liệu (index stale không bao giờ được rò ra ngoài).
 * Tài liệu của user/course bị suspended/deleted phải rời index.
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
        const [c] = await db.select().from(course).where(eq(course.id, itemId));
        if (!c || !c.visible) return null;
        const ctx = await this.contexts.getByLevelInstance(50, itemId);
        if (!ctx) return null;
        return { title: c.fullName, content: `${c.shortName} ${c.summary}`, contextId: ctx.id };
      },
      listIds: async () => (await db.select().from(course)).map((r) => r.id),
    });
    // Area: users — hồ sơ công khai; user suspended/deleted không được index.
    this.registerArea({
      name: 'users',
      fetch: async (itemId) => {
        const [u] = await db.select().from(users).where(eq(users.id, itemId));
        if (!u || u.suspended || u.deleted || u.isGuest) return null;
        const ctx = await this.contexts.getByLevelInstance(30, itemId);
        const sys = ctx ?? (await this.contexts.ensureSystemContext());
        return { title: `${u.firstName} ${u.lastName}`.trim() || u.username, content: `${u.username} ${u.email}`, contextId: sys.id, ownerId: u.id };
      },
      listIds: async () => (await db.select().from(users)).filter((u) => !u.suspended && !u.deleted).map((r) => r.id),
    });
    // Area: contentbank — chỉ nội dung public mới vào index.
    this.registerArea({
      name: 'contentbank',
      fetch: async (itemId) => {
        const [c] = await db.select().from(contentBankContent).where(eq(contentBankContent.id, itemId));
        if (!c || c.visibility !== 'public') return null;
        return { title: c.name, content: `${c.name} ${c.contentType}`, contextId: c.contextId, ownerId: c.creatorId };
      },
      listIds: async () => (await db.select().from(contentBankContent)).filter((c) => c.visibility === 'public').map((r) => r.id),
    });
    // Area: blog — bài public (site) thuộc user context của tác giả.
    this.registerArea({
      name: 'blog',
      fetch: async (itemId) => {
        const [p] = await db.select().from(blogPosts).where(eq(blogPosts.id, itemId));
        if (!p || p.publishState !== 'site') return null;
        const ctx = await this.contexts.getByLevelInstance(30, p.userId);
        const sys = ctx ?? (await this.contexts.ensureSystemContext());
        return { title: p.subject, content: `${p.subject} ${p.summary} ${p.content}`, contextId: sys.id, ownerId: p.userId };
      },
      listIds: async () => (await db.select().from(blogPosts)).filter((p) => p.publishState === 'site').map((r) => r.id),
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
   * Tìm kiếm toàn cục cho một user: engine trả ứng viên, sau đó lọc bằng
   * PermissionEvaluator tại thời điểm truy vấn (course:view ở context
   * của tài liệu) và RE-CHECK bằng cách fetch lại bản ghi gốc qua area —
   * tài liệu gốc đã suspended/deleted/ẩn thì bị loại dù index còn sót.
   */
  async search(userId: string, q: string): Promise<SearchDocRow[]> {
    const candidates = await this.repo.queryEngine(q);
    const out: SearchDocRow[] = [];
    /** Capability bắt buộc theo từng area — mỗi area khai báo đúng một capability để re-check, không OR nhiều capability. */
    const areaCapability: Record<string, string> = {
      courses: 'course:view',
      users: 'user:viewdetails',
      contentbank: 'contentbank:viewcontent',
      blog: 'blog:view',
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
  async countDocs(): Promise<number> { return (await this.repo.listAll()).length; }
  /** Truy vấn SQL thô phục vụ chẩn đoán — không dùng trong luồng nghiệp vụ. */
  async ping(): Promise<boolean> { await this.repo.dbHandle.execute(sql`select 1`); return true; }
}
