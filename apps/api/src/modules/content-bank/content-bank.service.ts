import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { FilesService } from '../files/files.service';
import { SearchService } from '../search/search.service';
import { ContentBankRepository, type ContentRow } from './content-bank.repository';

/** Các loại nội dung đã đăng ký — loại nội dung là extension point, bản này cài 'file-based' generic. */
export const CONTENT_TYPES = ['file-based'] as const;

/**
 * ContentBankModule facade (Moodle core_contentbank, §2#25).
 * Nội dung thuộc một context, có tác giả, trạng thái draft/public, file qua
 * FilesModule. Quyền sửa/xem dùng capability RIÊNG của content bank
 * (moodle/contentbank:*), không suy từ quyền course chung.
 */
@Injectable()
export class ContentBankService {
  constructor(
    private readonly repo: ContentBankRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly files: FilesService,
    private readonly search: SearchService,
  ) {}

  async get(id: string): Promise<ContentRow> {
    const row = await this.repo.get(id);
    if (!row) throw new NotFoundException({ message: `Content ${id} not found`, code: 'contentbank.not_found' });
    return row;
  }

  /** Ai được xem: nội dung public cần viewcontent; draft chỉ tác giả hoặc người có editcontent. */
  async canView(userId: string, row: ContentRow): Promise<boolean> {
    if (row.creatorId === userId) return true;
    if (await this.evaluator.hasCapability(userId, 'moodle/contentbank:editcontent', row.contextId)) return true;
    if (row.visibility !== 'public') return false;
    return this.evaluator.hasCapability(userId, 'moodle/contentbank:viewcontent', row.contextId);
  }

  async create(actorId: string, input: { name: string; contextId: string; contentType?: string; visibility?: string; fileId?: string }): Promise<ContentRow> {
    await this.evaluator.requireCapability(actorId, 'moodle/contentbank:upload', input.contextId);
    const row = await this.repo.insert({
      name: input.name, contextId: input.contextId, creatorId: actorId,
      contentType: input.contentType ?? 'file-based', visibility: input.visibility ?? 'draft', fileId: input.fileId ?? null,
    });
    if (row.visibility === 'public') await this.search.indexItem('contentbank', row.id);
    return row;
  }

  async listFor(userId: string, contextId?: string): Promise<ContentRow[]> {
    const rows = contextId ? await this.repo.listByContext(contextId) : await this.repo.list();
    const out: ContentRow[] = [];
    for (const row of rows) if (await this.canView(userId, row)) out.push(row);
    return out;
  }

  async getFor(userId: string, id: string): Promise<ContentRow> {
    const row = await this.get(id);
    if (!(await this.canView(userId, row))) throw new ForbiddenException({ message: 'You cannot view this content bank item', code: 'contentbank.view_denied' });
    return row;
  }

  async update(actorId: string, id: string, input: { name?: string; visibility?: string; fileId?: string }): Promise<ContentRow> {
    const row = await this.get(id);
    if (row.creatorId !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/contentbank:editcontent', row.contextId);
    await this.repo.update(id, { name: input.name ?? row.name, visibility: input.visibility ?? row.visibility, fileId: input.fileId ?? row.fileId });
    const updated = await this.get(id);
    // Đồng bộ index: public thì index, draft thì gỡ.
    if (updated.visibility === 'public') await this.search.indexItem('contentbank', updated.id);
    else await this.search.removeDoc('contentbank', updated.id);
    return updated;
  }

  async remove(actorId: string, id: string): Promise<void> {
    const row = await this.get(id);
    if (row.creatorId !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/contentbank:editcontent', row.contextId);
    await this.repo.remove(id);
    await this.search.removeDoc('contentbank', id);
  }

  /** Upload file qua FilesModule và gắn vào nội dung. */
  async uploadFile(actorId: string, id: string, input: { fileName: string; contentBase64: string; mimeType?: string }): Promise<ContentRow> {
    const row = await this.get(id);
    if (row.creatorId !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/contentbank:editcontent', row.contextId);
    const data = Buffer.from(input.contentBase64, 'base64');
    const file = await this.files.upload({
      contextId: row.contextId, component: 'core_contentbank', fileArea: 'content', itemId: row.id,
      fileName: input.fileName, data, mimeType: input.mimeType, userId: actorId,
    });
    await this.repo.update(id, { fileId: file.id });
    return this.get(id);
  }

  /** Signed URL của file đính kèm — FilesModule tự re-check quyền file. */
  async signedUrl(actorId: string, id: string): Promise<{ url: string; expiresAt: number }> {
    const row = await this.getFor(actorId, id);
    if (!row.fileId) throw new NotFoundException({ message: 'Content has no file', code: 'contentbank.no_file' });
    return this.files.createSignedUrl(row.fileId, actorId);
  }
}
