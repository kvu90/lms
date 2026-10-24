import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, inArray } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import type { CmRow } from '../courses/courses.repository';
import { FilesService } from '../files/files.service';
import { courseGroups, courseModulesCompletion, enrol, groupsMembers, userEnrolments } from '../../db/schema';
import { ContentRepository, type PageRow, type ResourceRow } from './content.repository';

export const PAGE_COMPONENT = 'mod_page';
export const RESOURCE_COMPONENT = 'mod_resource';

type CompletionMode = 'view' | 'manual' | 'none';

/** Ánh xạ chế độ hoàn thành của mục nội dung sang các trường completion của course module. */
function completionFields(mode: CompletionMode): { completion: number; completionView: boolean; completionManual: boolean; completionUseGrade: boolean } {
  if (mode === 'view') return { completion: 2, completionView: true, completionManual: false, completionUseGrade: false };
  if (mode === 'manual') return { completion: 1, completionView: false, completionManual: true, completionUseGrade: false };
  return { completion: 0, completionView: false, completionManual: false, completionUseGrade: false };
}

/** Suy chế độ hoàn thành từ các trường của course module (đảo ngược completionFields). */
function modeOfCm(cm: CmRow): CompletionMode {
  if (cm.completion === 0) return 'none';
  if (cm.completionView) return 'view';
  return 'manual';
}

/** URL nhúng cho video/liên kết ngoài (YouTube/Vimeo) — null nếu không nhúng được. */
export function embedUrlFor(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

export interface OutlineItemProgress {
  cmId: string; name: string; component: string; instanceId: string | null;
  completion: number; state: number; viewed: boolean; done: boolean;
}
export interface SectionProgress {
  sectionId: string; name: string | null; section: number;
  total: number; completed: number; percent: number | null;
  items: OutlineItemProgress[];
}
export interface MyProgress {
  courseId: string;
  total: number; completed: number; percent: number | null;
  sections: SectionProgress[];
  lastAccess: { cmId: string; at: string } | null;
  resume: { cmId: string; reason: 'last_access' | 'next_incomplete' | 'all_done' | 'start' } | null;
}
export interface ClassMarker {
  scope: 'group' | 'course';
  groupId: string | null; groupName: string;
  memberCount: number;
  markerCmId: string | null; markerName: string | null; markerIndex: number;
  percent: number | null;
}

@Injectable()
/**
 * Học liệu trong khoá (K2): trang đọc mod_page, tài nguyên mod_resource
 * (tệp/liên kết/video), trang học (player), tổng hợp tiến độ học từ dữ
 * liệu completion và mốc tiến độ theo lớp (nhóm) trên outline.
 */
export class ContentService {
  constructor(
    private readonly repo: ContentRepository,
    private readonly courses: CoursesService,
    private readonly completion: CompletionService,
    private readonly files: FilesService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  // --- mod_page ---------------------------------------------------------------

  /**
   * Tạo trang đọc: bản ghi page + course module (component mod_page).
   * Quyền tạo hoạt động do CoursesService kiểm (course:manageactivities).
   * Mặc định hoàn thành theo lượt xem (completion=2 + completionView).
   */
  async createPage(actorId: string, courseId: string, input: {
    sectionId: string; name: string; content?: string; completionMode?: CompletionMode;
  }): Promise<PageRow & { completionMode: CompletionMode }> {
    await this.courses.getCourse(courseId);
    const mode = input.completionMode ?? 'view';
    const page = await this.repo.insertPage({ course: courseId, cmId: null, name: input.name, content: input.content ?? '' });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: PAGE_COMPONENT, instanceId: page.id, name: input.name,
        ...completionFields(mode),
      });
      await this.repo.updatePage(page.id, { cmId: cm.id });
    } catch (err) {
      await this.repo.deletePage(page.id).catch(() => undefined);
      throw err;
    }
    const created = await this.getPage(page.id);
    return { ...created, completionMode: mode };
  }

  /** Lấy trang đọc (kèm chế độ hoàn thành suy từ cm của nó). */
  async getPage(id: string): Promise<PageRow> {
    const row = await this.repo.getPage(id);
    if (!row) throw new NotFoundException({ message: `Page ${id} not found`, code: 'content.page_not_found' });
    return row;
  }

  /** Đọc trang đọc cho người xem: phải qua được cổng truy cập khoá học. */
  async getPageForUser(userId: string, id: string): Promise<PageRow & { completionMode: CompletionMode }> {
    const page = await this.getPage(id);
    await this.courses.assertCourseAccess(userId, page.course);
    const cm = page.cmId ? await this.courses.getCm(page.cmId) : null;
    return { ...page, completionMode: cm ? modeOfCm(cm) : 'view' };
  }

  /** Sửa trang đọc (course:manageactivities tại khoá); đổi tên/chế độ hoàn thành đồng bộ sang cm. */
  async updatePage(actorId: string, id: string, input: {
    name?: string; content?: string; completionMode?: CompletionMode;
  }): Promise<PageRow> {
    const page = await this.getPage(id);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courses.courseContextId(page.course));
    const patch: Partial<PageRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.content !== undefined) patch.content = input.content;
    if (Object.keys(patch).length) await this.repo.updatePage(id, patch);
    if (page.cmId && (input.name !== undefined || input.completionMode !== undefined)) {
      await this.courses.updateCm(actorId, page.cmId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.completionMode !== undefined ? completionFields(input.completionMode) : {}),
      });
    }
    return this.getPage(id);
  }

  /** Xoá trang đọc: xoá cm qua CoursesService (phát cm_deleted) và xoá bản ghi page. */
  async deletePage(actorId: string, id: string): Promise<void> {
    const page = await this.getPage(id);
    if (page.cmId) await this.courses.deleteCm(actorId, page.cmId);
    await this.repo.deletePage(id);
  }

  // --- mod_resource -------------------------------------------------------------

  /**
   * Tạo tài nguyên: đúng một nguồn (file đã tải lên qua Files, hoặc URL
   * ngoài/video nhúng). Mặc định hoàn thành: file = theo lượt xem,
   * url = thủ công (học sinh tự đánh dấu đã học vì hệ thống không đo
   * được việc xem ở đích ngoài).
   */
  async createResource(actorId: string, courseId: string, input: {
    sectionId: string; name: string; kind: 'file' | 'url';
    fileId?: string; url?: string; completionMode?: CompletionMode;
  }): Promise<ResourceRow & { completionMode: CompletionMode }> {
    await this.courses.getCourse(courseId);
    if (input.kind === 'file') {
      if (!input.fileId) throw new BadRequestException({ message: 'fileId is required for a file resource', code: 'content.file_required' });
      await this.files.getFile(input.fileId);
    } else {
      if (!input.url) throw new BadRequestException({ message: 'url is required for a link resource', code: 'content.url_required' });
    }
    const mode = input.completionMode ?? (input.kind === 'file' ? 'view' : 'manual');
    const resource = await this.repo.insertResource({
      course: courseId, cmId: null, name: input.name, kind: input.kind,
      fileId: input.kind === 'file' ? input.fileId! : null,
      url: input.kind === 'url' ? input.url! : null,
    });
    try {
      const cm = await this.courses.createCm(actorId, courseId, {
        sectionId: input.sectionId, component: RESOURCE_COMPONENT, instanceId: resource.id, name: input.name,
        ...completionFields(mode),
      });
      await this.repo.updateResource(resource.id, { cmId: cm.id });
    } catch (err) {
      await this.repo.deleteResource(resource.id).catch(() => undefined);
      throw err;
    }
    const created = await this.getResource(resource.id);
    return { ...created, completionMode: mode };
  }

  /** Lấy tài nguyên. */
  async getResource(id: string): Promise<ResourceRow> {
    const row = await this.repo.getResource(id);
    if (!row) throw new NotFoundException({ message: `Resource ${id} not found`, code: 'content.resource_not_found' });
    return row;
  }

  /** Đọc tài nguyên cho người xem: qua cổng khoá học; file kèm URL đã ký để xem/tải. */
  async getResourceForUser(userId: string, id: string): Promise<{
    resource: ResourceRow & { completionMode: CompletionMode };
    file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string; signedUrlExpiresAt: number } | null;
    embedUrl: string | null;
  }> {
    const resource = await this.getResource(id);
    await this.courses.assertCourseAccess(userId, resource.course);
    const cm = resource.cmId ? await this.courses.getCm(resource.cmId) : null;
    let file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string; signedUrlExpiresAt: number } | null = null;
    if (resource.kind === 'file' && resource.fileId) {
      const row = await this.files.getFile(resource.fileId);
      const signed = await this.files.createSignedUrl(resource.fileId, userId);
      file = { id: row.id, fileName: row.fileName, mimeType: row.mimeType, fileSize: row.fileSize, signedUrl: signed.url, signedUrlExpiresAt: signed.expiresAt };
    }
    return {
      resource: { ...resource, completionMode: cm ? modeOfCm(cm) : 'view' },
      file,
      embedUrl: resource.kind === 'url' && resource.url ? embedUrlFor(resource.url) : null,
    };
  }

  /** Sửa tài nguyên (course:manageactivities tại khoá); tên/chế độ hoàn thành đồng bộ sang cm. */
  async updateResource(actorId: string, id: string, input: {
    name?: string; fileId?: string | null; url?: string | null; completionMode?: CompletionMode;
  }): Promise<ResourceRow> {
    const resource = await this.getResource(id);
    await this.evaluator.requireCapability(actorId, 'course:manageactivities', await this.courses.courseContextId(resource.course));
    const patch: Partial<ResourceRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.fileId !== undefined) {
      if (input.fileId) await this.files.getFile(input.fileId);
      patch.fileId = input.fileId; patch.kind = input.fileId ? 'file' : resource.kind;
    }
    if (input.url !== undefined) patch.url = input.url;
    if (Object.keys(patch).length) await this.repo.updateResource(id, patch);
    if (resource.cmId && (input.name !== undefined || input.completionMode !== undefined)) {
      await this.courses.updateCm(actorId, resource.cmId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.completionMode !== undefined ? completionFields(input.completionMode) : {}),
      });
    }
    return this.getResource(id);
  }

  /** Xoá tài nguyên: xoá cm qua CoursesService và xoá bản ghi resource. */
  async deleteResource(actorId: string, id: string): Promise<void> {
    const resource = await this.getResource(id);
    if (resource.cmId) await this.courses.deleteCm(actorId, resource.cmId);
    await this.repo.deleteResource(id);
  }

  /** Dọn instance khi course module bị xoá từ nơi khác (idempotent). */
  @OnEvent('cm_deleted')
  async onCmDeleted(payload: { cmId: string; component?: string }): Promise<void> {
    if (payload.component === PAGE_COMPONENT) await this.repo.deletePageByCm(payload.cmId);
    if (payload.component === RESOURCE_COMPONENT) await this.repo.deleteResourceByCm(payload.cmId);
  }

  // --- tiến độ ------------------------------------------------------------------

  /**
   * Tổng hợp tiến độ của một học sinh trong khoá từ dữ liệu completion:
   * chỉ các cm có bật theo dõi (completion != 0) và hiển thị được với
   * học sinh mới vào mẫu số. % = đã xong / tổng mục theo dõi (làm tròn);
   * percent = null khi khoá chưa có mục nào được theo dõi.
   */
  async getMyProgress(userId: string, courseId: string): Promise<MyProgress> {
    const content = await this.courses.getCourseContent(userId, courseId);
    const completions = await this.completion.listCmCompletionsForCourse(courseId, userId);
    const byCm = new Map(completions.map((c) => [c.cmId, c]));
    const sections: SectionProgress[] = [];
    let total = 0; let completed = 0;
    for (const section of content.sections) {
      const items: OutlineItemProgress[] = [];
      let sTotal = 0; let sCompleted = 0;
      for (const cm of section.modules) {
        const row = byCm.get(cm.id);
        const state = row?.state ?? 0;
        const done = cm.completion !== 0 && state !== 0;
        items.push({
          cmId: cm.id, name: cm.name, component: cm.component, instanceId: cm.instanceId,
          completion: cm.completion, state, viewed: row?.viewed ?? false, done,
        });
        if (cm.completion !== 0) { sTotal += 1; if (state !== 0) sCompleted += 1; }
      }
      total += sTotal; completed += sCompleted;
      sections.push({
        sectionId: section.id, name: section.name, section: section.section,
        total: sTotal, completed: sCompleted,
        percent: sTotal ? Math.round((sCompleted / sTotal) * 100) : null,
        items,
      });
    }
    const last = await this.repo.getLastAccess(userId, courseId);
    const flat = sections.flatMap((s) => s.items);
    const resume = this.resolveResume(flat, last?.cmId ?? null);
    return {
      courseId,
      total, completed,
      percent: total ? Math.round((completed / total) * 100) : null,
      sections,
      lastAccess: last ? { cmId: last.cmId, at: last.accessedAt.toISOString() } : null,
      resume,
    };
  }

  /** Chọn mục "Học tiếp": ưu tiên mục mở gần nhất còn dở, rồi mục theo dõi đầu tiên chưa xong. */
  private resolveResume(flat: OutlineItemProgress[], lastCmId: string | null): MyProgress['resume'] {
    if (!flat.length) return null;
    const byId = new Map(flat.map((i) => [i.cmId, i]));
    const last = lastCmId ? byId.get(lastCmId) : undefined;
    if (last && !last.done) return { cmId: last.cmId, reason: 'last_access' };
    const next = flat.find((i) => i.completion !== 0 && !i.done);
    if (next) return { cmId: next.cmId, reason: last ? 'next_incomplete' : 'start' };
    if (last) return { cmId: last.cmId, reason: 'all_done' };
    return { cmId: flat[0]!.cmId, reason: 'start' };
  }

  /**
   * Mốc "lớp đã học tới đây" cho outline: với mỗi lớp (nhóm của khoá),
   * mốc là cm theo dõi cuối cùng của tiền tố outline mà tại mọi cm trong
   * tiền tố, ít nhất một nửa thành viên lớp đã hoàn thành. Khoá không có
   * nhóm thì tính một mốc cho toàn bộ học sinh đang ghi danh hiệu lực.
   */
  async getClassMarkers(userId: string, courseId: string): Promise<{ courseId: string; trackedTotal: number; markers: ClassMarker[] }> {
    await this.courses.assertCourseAccess(userId, courseId);
    const db = this.repo.dbHandle;
    const sections = await this.courses.listSections(courseId);
    const sectionOrder = new Map(sections.map((s) => [s.id, s.section]));
    const cms = (await this.courses.listCms(courseId))
      .filter((cm) => cm.completion !== 0)
      .sort((a, b) => (sectionOrder.get(a.section) ?? 0) - (sectionOrder.get(b.section) ?? 0));
    const trackedIds = cms.map((cm) => cm.id);
    const completedByCm = new Map<string, Set<string>>();
    if (trackedIds.length) {
      const rows = await db.select().from(courseModulesCompletion)
        .where(inArray(courseModulesCompletion.courseModuleId, trackedIds));
      for (const row of rows) {
        if (row.completionState === 0) continue;
        const set = completedByCm.get(row.courseModuleId) ?? new Set<string>();
        set.add(row.userId);
        completedByCm.set(row.courseModuleId, set);
      }
    }
    const markerFor = (scope: 'group' | 'course', groupId: string | null, groupName: string, memberIds: string[]): ClassMarker => {
      const members = new Set(memberIds);
      let markerIndex = -1;
      for (let i = 0; i < cms.length; i += 1) {
        const doneBy = completedByCm.get(cms[i]!.id) ?? new Set<string>();
        const done = [...members].filter((m) => doneBy.has(m)).length;
        if (members.size > 0 && done / members.size >= 0.5) markerIndex = i; else break;
      }
      let pairs = 0; let donePairs = 0;
      for (const cm of cms) {
        const doneBy = completedByCm.get(cm.id) ?? new Set<string>();
        for (const m of members) { pairs += 1; if (doneBy.has(m)) donePairs += 1; }
      }
      const markerCm = markerIndex >= 0 ? cms[markerIndex]! : null;
      return {
        scope, groupId, groupName, memberCount: members.size,
        markerCmId: markerCm?.id ?? null, markerName: markerCm?.name ?? null, markerIndex,
        percent: pairs ? Math.round((donePairs / pairs) * 100) : null,
      };
    };
    const groups = await db.select().from(courseGroups).where(eq(courseGroups.courseId, courseId));
    const markers: ClassMarker[] = [];
    if (groups.length) {
      const memberRows = await db.select().from(groupsMembers)
        .where(inArray(groupsMembers.groupId, groups.map((g) => g.id)));
      for (const group of groups) {
        const ids = memberRows.filter((r) => r.groupId === group.id).map((r) => r.userId);
        markers.push(markerFor('group', group.id, group.name, ids));
      }
    } else {
      const rows = await db.select({ userId: userEnrolments.userId }).from(userEnrolments)
        .innerJoin(enrol, eq(userEnrolments.enrolId, enrol.id))
        .where(and(eq(enrol.courseId, courseId), eq(userEnrolments.status, 0)));
      markers.push(markerFor('course', null, 'Toàn khoá', [...new Set(rows.map((r) => r.userId))]));
    }
    return { courseId, trackedTotal: cms.length, markers };
  }

  // --- player -------------------------------------------------------------------

  /**
   * Dữ liệu trang học (player) cho một cm: nội dung của mục, outline kèm
   * trạng thái hoàn thành của chính học sinh, mục Trước/Tiếp và tiến độ
   * tổng. Mở player là hành vi "truy cập học" — ghi last-access để Học
   * tiếp đưa học sinh về đúng mục dở dang.
   */
  async getPlayer(userId: string, courseId: string, cmId: string): Promise<{
    course: { id: string; fullName: string; shortName: string };
    cm: CmRow;
    content:
      | { type: 'page'; page: PageRow }
      | { type: 'resource'; resource: ResourceRow; file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string; signedUrlExpiresAt: number } | null; embedUrl: string | null }
      | { type: 'other'; component: string };
    completion: { state: number; viewed: boolean; mode: CompletionMode };
    progress: MyProgress;
    prevCmId: string | null; nextCmId: string | null;
  }> {
    const courseRow = await this.courses.assertCourseAccess(userId, courseId);
    const cm = await this.courses.getCm(cmId);
    if (cm.course !== courseId) throw new NotFoundException({ message: `Course module ${cmId} not found in course ${courseId}`, code: 'content.cm_not_in_course' });
    const access = await this.courses.checkCmAccess(userId, cm);
    if (!access.available) throw new ForbiddenException({ message: 'This activity is not available to you yet', code: 'availability.not_available' });
    await this.repo.upsertLastAccess(userId, courseId, cmId);
    let content: { type: 'page'; page: PageRow } | { type: 'resource'; resource: ResourceRow; file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string; signedUrlExpiresAt: number } | null; embedUrl: string | null } | { type: 'other'; component: string };
    if (cm.component === PAGE_COMPONENT && cm.instanceId) {
      content = { type: 'page', page: await this.getPage(cm.instanceId) };
    } else if (cm.component === RESOURCE_COMPONENT && cm.instanceId) {
      const view = await this.getResourceForUser(userId, cm.instanceId);
      content = { type: 'resource', resource: view.resource, file: view.file, embedUrl: view.embedUrl };
    } else {
      content = { type: 'other', component: cm.component };
    }
    const progress = await this.getMyProgress(userId, courseId);
    const flat = progress.sections.flatMap((s) => s.items);
    const idx = flat.findIndex((i) => i.cmId === cmId);
    const mine = await this.completion.getCmCompletion(cmId, userId);
    return {
      course: { id: courseRow.id, fullName: courseRow.fullName, shortName: courseRow.shortName },
      cm,
      content,
      completion: { state: mine.state, viewed: mine.viewed, mode: modeOfCm(cm) },
      progress,
      prevCmId: idx > 0 ? flat[idx - 1]!.cmId : null,
      nextCmId: idx >= 0 && idx < flat.length - 1 ? flat[idx + 1]!.cmId : null,
    };
  }
}
