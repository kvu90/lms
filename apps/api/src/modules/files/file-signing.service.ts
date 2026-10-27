import { Inject, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { OBJECT_STORAGE, supportsPresignedDownloads, type ObjectStorage } from './storage';

/** Token tải xuống ngắn hạn được ký bằng HMAC cho lưu trữ cục bộ; khi adapter lưu trữ hỗ trợ URL presigned (S3), đích tải xuống thay vào đó là URL presigned trỏ thẳng tới kho lưu trữ. */
@Injectable()
/**
 * Ký URL tải file có thời hạn: HMAC qua API cho kho local; adapter có năng lực presigned (S3)
 * thì phát URL presigned trỏ thẳng tới kho. Chữ ký không thay thế kiểm quyền — chỉ dùng cho
 * các area được phép chia sẻ liên kết tạm thời; kiểm quyền vẫn diễn ra ở server trước khi phát.
 */
export class FileSigningService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  constructor(
    config: ConfigService,
    @Optional() @Inject(OBJECT_STORAGE) private readonly storage?: ObjectStorage,
  ) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    this.ttlSeconds = config.get<number>('FILE_SIGNED_URL_TTL_SECONDS') ?? 300;
  }
  /**
   * Tạo chữ ký cho một file id với thời hạn cho trước.
   */
  sign(fileId: string): { token: string; expiresAt: number } {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const mac = createHmac('sha256', this.secret).update(`${fileId}.${expiresAt}`).digest('base64url');
    return { token: `${expiresAt}.${mac}`, expiresAt };
  }
  /**
   * Phát hành đích tải xuống cho một file: adapter có năng lực presigned (S3) → URL presigned
   * trỏ thẳng tới kho kèm hạn dùng; còn lại → URL tải qua API kèm chữ ký HMAC như hành vi cũ.
   * Kiểm quyền tại context do FilesService thực hiện TRƯỚC khi gọi hàm này.
   */
  async createDownloadTarget(file: { id: string; contentHash: string; fileName: string; mimeType?: string | null }): Promise<{ url: string; expiresAt: number }> {
    if (this.storage && supportsPresignedDownloads(this.storage)) {
      const url = await this.storage.presignGetUrl(file.contentHash, this.ttlSeconds, {
        fileName: file.fileName, mimeType: file.mimeType ?? undefined,
      });
      return { url, expiresAt: Math.floor(Date.now() / 1000) + this.ttlSeconds };
    }
    const { token, expiresAt } = this.sign(file.id);
    return { url: `/api/v1/files/${file.id}/download?sig=${encodeURIComponent(token)}`, expiresAt };
  }
  /**
   * Kiểm chữ ký và hạn dùng của URL đã ký.
   */
  verify(fileId: string, token: string | undefined): void {
    if (!token) throw new UnauthorizedException({ message: 'Missing file signature', code: 'file.signature_missing' });
    const [expRaw, mac] = token.split('.');
    const expiresAt = Number(expRaw);
    if (!mac || Number.isNaN(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException({ message: 'File signature expired or invalid', code: 'file.signature_invalid' });
    }
    const expected = createHmac('sha256', this.secret).update(`${fileId}.${expiresAt}`).digest('base64url');
    const a = Buffer.from(mac); const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException({ message: 'File signature expired or invalid', code: 'file.signature_invalid' });
    }
  }
}
