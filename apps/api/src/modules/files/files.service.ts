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
  contextId: string; component: string; fileArea: string; itemId?: string;
  filePath?: string; fileName: string; data: Buffer; mimeType?: string; userId?: string;
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
 * Dịch vụ file kiểu Moodle: upload, dedup theo contentHash, tải xuống theo quyền context,
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
    if (!input.fileName || input.fileName.includes('/') || input.fileName.includes('\\')) {
      throw new BadRequestException({ message: 'Invalid filename', code: 'file.invalid_filename' });
    }
    const contentHash = sha256Hex(input.data);
    await this.storage.put(contentHash, input.data); // put() is a no-op when the hash already exists (dedup)
    return this.repo.insert({
      contentHash, contextId: input.contextId, component: input.component, fileArea: input.fileArea,
      itemId: input.itemId ?? null, filePath: input.filePath ?? '/', fileName: input.fileName,
      userId: input.userId, fileSize: input.data.length, mimeType: input.mimeType,
    });
  }

  /**
   * Lấy metadata file; ném files.not_found khi vắng.
   */
  async getFile(id: string): Promise<FileRow> {
    const row = await this.repo.getById(id);
    if (!row) throw new NotFoundException({ message: `File ${id} not found`, code: 'file.not_found' });
    return row;
  }
  /**
   * Số bản ghi đang tham chiếu cùng nội dung vật lý.
   */
  async refcount(contentHash: string): Promise<number> { return this.repo.countByHash(contentHash); }
  /**
   * Khoá lưu trữ vật lý suy từ contentHash.
   */
  physicalKey(contentHash: string): string { return this.storage.keyFor(contentHash); }
  /**
   * Nội dung vật lý còn trên kho lưu trữ hay không.
   */
  async physicalExists(contentHash: string): Promise<boolean> { return this.storage.exists(contentHash); }

  /**
   * Deleting a record NEVER deletes bytes while other records reference the
   * same hash; when the refcount reaches zero an orphan-cleanup job is queued
   * for the worker (jobId dedups repeated enqueues for the same hash).
   */
  /**
   * Xoá bản ghi file; xoá nội dung vật lý khi refcount về 0.
   */
  async deleteFile(id: string): Promise<{ deleted: true; contentHash: string; refcount: number }> {
    const row = await this.getFile(id);
    await this.repo.deleteById(id);
    const refcount = await this.repo.countByHash(row.contentHash);
    if (refcount === 0) {
      await this.cleanupQueue.add('cleanup-orphan', { contentHash: row.contentHash }, { jobId: `orphan-${row.contentHash}`, attempts: 3 });
    }
    return { deleted: true, contentHash: row.contentHash, refcount };
  }

  /** Worker-side: remove physical bytes only if the hash is still unreferenced at execution time. */
  /**
   * Dọn một nội dung vật lý mồ côi theo hash (worker file-cleanup gọi).
   */
  async cleanupOrphan(contentHash: string): Promise<boolean> {
    if ((await this.repo.countByHash(contentHash)) > 0) return false;
    await this.storage.delete(contentHash);
    return true;
  }

  /**
   * Kiểm quyền xem file tại context của nó.
   */
  async assertCanView(file: FileRow, actor: { id: string; username?: string }): Promise<void> {
    await this.evaluator.requireCapability(actor.id, 'files:view', file.contextId, { isGuest: actor.username === 'guest' });
  }
  /**
   * Kiểm quyền tải file lên context đích.
   */
  async assertCanUpload(contextId: string, actor: { id: string; username?: string }): Promise<void> {
    await this.evaluator.requireCapability(actor.id, 'files:upload', contextId, { isGuest: actor.username === 'guest' });
  }

  /** Capability-checked signed URL issuance: the check happens HERE (server), the signature only transports the result briefly.
   * Issuance itself is delegated to FileSigningService, which returns a presigned S3 URL when the
   * storage adapter supports it (driver=s3) and the HMAC API URL otherwise (driver=local, unchanged). */
  /**
   * Tạo URL tải có ký + hạn dùng (presigned khi driver S3, HMAC khi local).
   */
  async createSignedUrl(fileId: string, userId: string, isGuest = false): Promise<{ url: string; expiresAt: number }> {
    const file = await this.getFile(fileId);
    await this.evaluator.requireCapability(userId, 'files:view', file.contextId, { isGuest });
    return this.signing.createDownloadTarget(file);
  }
  /**
   * Kiểm chữ ký URL (ủy quyền cho FileSigningService).
   */
  verifySignature(fileId: string, token: string | undefined): void { this.signing.verify(fileId, token); }
  /**
   * Đọc nội dung file (sau kiểm quyền) để trả về/tải xuống.
   */
  async readContent(fileId: string): Promise<{ file: FileRow; data: Buffer }> {
    const file = await this.getFile(fileId);
    const data = await this.storage.get(file.contentHash);
    return { file, data };
  }
  /**
   * Liệt kê file trong context.
   */
  async listByContext(contextId: string): Promise<FileRow[]> { return this.repo.listByContext(contextId); }
}
