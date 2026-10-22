import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { FilesRepository, type FileRow } from './files.repository';
import { FileSigningService } from './file-signing.service';
import { OBJECT_STORAGE, sha256Hex, type ObjectStorage } from './storage';
import { Inject } from '@nestjs/common';

export const FILE_CLEANUP_QUEUE = 'file-cleanup';
export interface UploadInput {
  contextid: number; component: string; filearea: string; itemid?: number;
  filepath?: string; filename: string; data: Buffer; mimetype?: string; userid?: number;
}

/**
 * FilesModule facade (Moodle core_files). Logical records in `files` point at
 * content-addressed physical bytes; identical content is stored ONCE no
 * matter how many records reference it. Files are never public by path: a
 * download requires the file context capability check first, then either a
 * short-lived signed URL or a guarded stream.
 */
@Injectable()
/**
 * Dịch vụ file kiểu Moodle: upload, dedup theo contenthash, tải xuống theo quyền context,
 * URL ký tạm thời và dọn nội dung vật lý khi refcount về 0.
 * Đối chiếu Moodle: lib/filelib.php và files/classes (file_storage).
 */
export class FilesService {
  constructor(
    private readonly repo: FilesRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly evaluator: PermissionEvaluator,
    private readonly signing: FileSigningService,
    @InjectQueue(FILE_CLEANUP_QUEUE) private readonly cleanupQueue: Queue,
  ) {}

  /**
   * Tải file lên: kiểm quyền tại context, tính hash, lưu nội dung (dedup) + metadata.
   */
  async upload(input: UploadInput): Promise<FileRow> {
    if (!input.filename || input.filename.includes('/') || input.filename.includes('\\')) {
      throw new BadRequestException({ message: 'Invalid filename', code: 'file.invalid_filename' });
    }
    const contenthash = sha256Hex(input.data);
    await this.storage.put(contenthash, input.data); // put() is a no-op when the hash already exists (dedup)
    return this.repo.insert({
      contenthash, contextid: input.contextid, component: input.component, filearea: input.filearea,
      itemid: input.itemid ?? 0, filepath: input.filepath ?? '/', filename: input.filename,
      userid: input.userid, filesize: input.data.length, mimetype: input.mimetype,
    });
  }

  /**
   * Lấy metadata file; ném files.not_found khi vắng.
   */
  async getFile(id: number): Promise<FileRow> {
    const row = await this.repo.getById(id);
    if (!row) throw new NotFoundException({ message: `File ${id} not found`, code: 'file.not_found' });
    return row;
  }
  /**
   * Số bản ghi đang tham chiếu cùng nội dung vật lý.
   */
  async refcount(contenthash: string): Promise<number> { return this.repo.countByHash(contenthash); }
  /**
   * Khoá lưu trữ vật lý suy từ contenthash.
   */
  physicalKey(contenthash: string): string { return this.storage.keyFor(contenthash); }
  /**
   * Nội dung vật lý còn trên kho lưu trữ hay không.
   */
  async physicalExists(contenthash: string): Promise<boolean> { return this.storage.exists(contenthash); }

  /**
   * Deleting a record NEVER deletes bytes while other records reference the
   * same hash; when the refcount reaches zero an orphan-cleanup job is queued
   * for the worker (jobId dedups repeated enqueues for the same hash).
   */
  /**
   * Xoá bản ghi file; xoá nội dung vật lý khi refcount về 0.
   */
  async deleteFile(id: number): Promise<{ deleted: true; contenthash: string; refcount: number }> {
    const row = await this.getFile(id);
    await this.repo.deleteById(id);
    const refcount = await this.repo.countByHash(row.contenthash);
    if (refcount === 0) {
      await this.cleanupQueue.add('cleanup-orphan', { contenthash: row.contenthash }, { jobId: `orphan-${row.contenthash}`, attempts: 3 });
    }
    return { deleted: true, contenthash: row.contenthash, refcount };
  }

  /** Worker-side: remove physical bytes only if the hash is still unreferenced at execution time. */
  /**
   * Dọn một nội dung vật lý mồ côi theo hash (worker file-cleanup gọi).
   */
  async cleanupOrphan(contenthash: string): Promise<boolean> {
    if ((await this.repo.countByHash(contenthash)) > 0) return false;
    await this.storage.delete(contenthash);
    return true;
  }

  /**
   * Kiểm quyền xem file tại context của nó.
   */
  async assertCanView(file: FileRow, actor: { id: number; username?: string }): Promise<void> {
    await this.evaluator.requireCapability(actor.id, 'lms/files:view', file.contextid, { isGuest: actor.username === 'guest' });
  }
  /**
   * Kiểm quyền tải file lên context đích.
   */
  async assertCanUpload(contextid: number, actor: { id: number; username?: string }): Promise<void> {
    await this.evaluator.requireCapability(actor.id, 'lms/files:upload', contextid, { isGuest: actor.username === 'guest' });
  }

  /** Capability-checked signed URL issuance: the check happens HERE (server), the signature only transports the result briefly. */
  /**
   * Tạo URL tải có ký + hạn dùng.
   */
  async createSignedUrl(fileId: number, userId: number, isGuest = false): Promise<{ url: string; expiresAt: number }> {
    const file = await this.getFile(fileId);
    await this.evaluator.requireCapability(userId, 'lms/files:view', file.contextid, { isGuest });
    const { token, expiresAt } = this.signing.sign(fileId);
    return { url: `/api/v1/files/${fileId}/download?sig=${encodeURIComponent(token)}`, expiresAt };
  }
  /**
   * Kiểm chữ ký URL (ủy quyền cho FileSigningService).
   */
  verifySignature(fileId: number, token: string | undefined): void { this.signing.verify(fileId, token); }
  /**
   * Đọc nội dung file (sau kiểm quyền) để trả về/tải xuống.
   */
  async readContent(fileId: number): Promise<{ file: FileRow; data: Buffer }> {
    const file = await this.getFile(fileId);
    const data = await this.storage.get(file.contenthash);
    return { file, data };
  }
  /**
   * Liệt kê file trong context.
   */
  async listByContext(contextid: number): Promise<FileRow[]> { return this.repo.listByContext(contextid); }
}
