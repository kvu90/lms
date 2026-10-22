import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-signed, short-lived download tokens for local storage (the S3 adapter would use presigned URLs instead). */
@Injectable()
/**
 * Ký URL tải file có thời hạn (HMAC): URL chứa hạn dùng và chữ ký, server kiểm chữ ký + hạn trước khi trả nội dung.
 * Chữ ký không thay thế kiểm quyền — chỉ dùng cho các area được phép chia sẻ liên kết tạm thời.
 */
export class FileSigningService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('JWT_SECRET');
    this.ttlSeconds = config.get<number>('FILE_SIGNED_URL_TTL_SECONDS') ?? 300;
  }
  /**
   * Tạo chữ ký cho một file id với thời hạn cho trước.
   */
  sign(fileId: number): { token: string; expiresAt: number } {
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    const mac = createHmac('sha256', this.secret).update(`${fileId}.${expiresAt}`).digest('base64url');
    return { token: `${expiresAt}.${mac}`, expiresAt };
  }
  /**
   * Kiểm chữ ký và hạn dùng của URL đã ký.
   */
  verify(fileId: number, token: string | undefined): void {
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
