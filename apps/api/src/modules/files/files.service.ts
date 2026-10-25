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

/** Trần dung lượng cho MỘT ảnh nhúng trong nội dung câu hỏi (8 MB — ngang bản gốc giaokhoa). */
export const QUESTION_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Định danh bền của một file trong nội dung rich text: đường content có gác
 * quyền của chính module files. Nội dung câu hỏi lưu dạng này (không lưu URL
 * ký — URL ký hết hạn sau 300 giây); khi phục vụ người đọc, tầng phục vụ gọi
 * `resolveQuestionImageUrls` để thay bằng URL ký còn hạn.
 */
export function questionFileContentSrc(fileId: string): string {
  return `/api/v1/files/${fileId}/content`;
}
export const QUESTION_FILE_CONTENT_SRC_PATTERN = /^\/api\/v1\/files\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/content$/;

/**
 * Nhận diện loại ảnh raster bằng MAGIC BYTES của chính nội dung — không tin
 * mimetype do client khai (bài học từ bản gốc giaokhoa: chỉ tin byte thật).
 * Trả null khi không phải PNG/JPEG/WebP/GIF.
 */
export function sniffImageMimeType(data: Buffer): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (data.length >= 6 && data.subarray(0, 4).toString('ascii') === 'GIF8'
    && (data[4] === 0x37 || data[4] === 0x39) && data[5] === 0x61) return 'image/gif';
  return null;
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
   * Tải MỘT ảnh nhúng cho nội dung câu hỏi (component 'question'): kiểm dung
   * lượng và loại ảnh bằng magic bytes TRƯỚC khi chạm kho lưu trữ — file
   * không phải ảnh raster bị từ chối dù đuôi tên/mimetype khai là ảnh.
   * Quyền tại context đích do controller gác bằng cổng files:upload như mọi
   * đường tải lên khác.
   */
  async uploadQuestionImage(input: {
    contextId: string; fileArea: string; itemId?: string;
    fileName: string; data: Buffer; userId?: string;
  }): Promise<FileRow> {
    if (input.data.length === 0) {
      throw new BadRequestException({ message: 'Empty file', code: 'file.empty' });
    }
    if (input.data.length > QUESTION_IMAGE_MAX_BYTES) {
      throw new BadRequestException({ message: 'Question image exceeds 8 MB', code: 'file.image_too_large' });
    }
    const mimeType = sniffImageMimeType(input.data);
    if (!mimeType) {
      throw new BadRequestException({ message: 'Only PNG, JPEG, WebP or GIF images are allowed in question content', code: 'file.not_image' });
    }
    return this.upload({
      contextId: input.contextId, component: 'question', fileArea: input.fileArea,
      itemId: input.itemId, fileName: input.fileName, data: input.data, mimeType, userId: input.userId,
    });
  }

  /**
   * Thay các node ảnh trong một tài liệu rich text (hoặc cấu trúc lồng nhau
   * bất kỳ chứa tài liệu) có `src` là định danh bền của file câu hỏi bằng URL
   * ký còn hạn. CHỈ dùng ở các bề mặt đã tự gác quyền đọc câu hỏi cho người
   * xem (chi tiết câu hỏi cho người đọc, view bài làm) — hàm này KHÔNG tự
   * kiểm files:view tại context của file, vì người đọc hợp lệ của một câu
   * (học sinh đang làm bài) không có quyền tại context bank của giáo viên;
   * cổng của bề mặt phục vụ thay thế cổng đó. File không tồn tại hoặc không
   * thuộc component 'question' thì giữ nguyên src.
   */
  async resolveQuestionImageUrls<T>(doc: T): Promise<T> {
    if (doc === null || typeof doc !== 'object') return doc;
    const clone = structuredClone(doc);
    const imageAttrs: Record<string, unknown>[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        if (rec.type === 'image' && rec.attrs && typeof rec.attrs === 'object') {
          const attrs = rec.attrs as Record<string, unknown>;
          if (typeof attrs.src === 'string' && QUESTION_FILE_CONTENT_SRC_PATTERN.test(attrs.src)) imageAttrs.push(attrs);
        }
        Object.values(rec).forEach(walk);
      }
    };
    walk(clone);
    await Promise.all(imageAttrs.map(async (attrs) => {
      const match = QUESTION_FILE_CONTENT_SRC_PATTERN.exec(attrs.src as string);
      if (!match) return;
      const file = await this.repo.getById(match[1]);
      if (!file || file.component !== 'question') return;
      const target = await this.signing.createDownloadTarget(file);
      attrs.src = target.url;
    }));
    return clone;
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
