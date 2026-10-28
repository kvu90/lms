import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { AuthRepository } from './auth.repository';

/** Nhãn issuer trong otpauth URL — tên hệ thống hiển thị trong ứng dụng authenticator. */
const TOTP_ISSUER = 'LMS';
/** Cửa sổ kiểm chứng TOTP: ±30 giây = ±1 bước 30s quanh thời điểm hiện tại (lệch đồng hồ authenticator). */
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;

@Injectable()
/**
 * MFA theo factor TOTP (đối chiếu Moodle tool_mfa factor_totp, RFC 6238):
 * sinh secret, dựng otpauth URL, kiểm chứng mã 6 số bước 30 giây với cửa sổ
 * ±1 bước — qua thư viện `otplib` (bản 13.5.0, API hàm `generateSecret` /
 * `generateURI` / `verify({ epochTolerance })` đã kiểm chứng với docs hiện hành).
 *
 * Bảo mật lưu trữ: secret KHÔNG lưu thô và KHÔNG bao giờ được ghi log.
 * Secret được mã hoá AES-256-GCM bằng khoá 32 byte suy ra SHA-256 từ biến
 * môi trường `MFA_ENCRYPTION_KEY`; biến này không bắt buộc — khi vắng mặt,
 * khoá được suy ra từ `JWT_SECRET` (đủ an toàn cho môi trường test/dev,
 * môi trường thật nên đặt khoá riêng để xoay vòng độc lập).
 */
export class TotpService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly config: ConfigService,
  ) {}

  /** Khoá mã hoá 32 byte suy ra từ MFA_ENCRYPTION_KEY, mặc định suy ra từ JWT_SECRET. */
  private encryptionKey(): Buffer {
    const material = this.config.get<string>('MFA_ENCRYPTION_KEY') ?? this.config.getOrThrow<string>('JWT_SECRET');
    return createHash('sha256').update(material).digest();
  }

  /**
   * Mã hoá secret TOTP trước khi lưu: AES-256-GCM, IV ngẫu nhiên mỗi lần;
   * định dạng lưu là base64url của `iv | authTag | ciphertext`.
   */
  private encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  /** Giải mã secret TOTP đã lưu; bản ghi bị sửa đổi sẽ làm GCM xác thực thất bại và ném lỗi. */
  private decryptSecret(stored: string): string {
    const raw = Buffer.from(stored, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  /**
   * Kiểm chứng một mã TOTP so với secret thô: đúng khi mã thuộc bước hiện
   * tại hoặc ±1 bước (otplib `epochTolerance: 30` giây). Mã sai định dạng
   * được coi là không hợp lệ thay vì ném lỗi ra ngoài.
   */
  async verifyCode(secret: string, code: string): Promise<boolean> {
    try {
      const result = await verify({ secret, token: code, epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS });
      return result.valid;
    } catch {
      return false;
    }
  }

  /** User có MFA TOTP đang bật hay không (đã setup VÀ đã xác nhận). */
  async isEnabled(userId: string): Promise<boolean> {
    const row = await this.repo.getTotpByUserId(userId);
    return row?.confirmed === true;
  }

  /**
   * Bước setup: sinh secret mới, lưu dạng mã hoá ở trạng thái CHƯA xác
   * nhận, và trả secret + otpauth URL — đây là lần duy nhất secret thô
   * rời khỏi server.
   *
   * Luồng theo trạng thái của factor hiện có:
   * - Chưa có bản ghi, hoặc bản ghi đang chờ xác nhận (chưa từng kích
   *   hoạt): setup/setup lại tự do, secret chờ bị thay — chưa có factor
   *   đang hoạt động nào bị hạ cấp.
   * - Bản ghi ĐÃ xác nhận (MFA đang bật): setup lại là thao tác THAY một
   *   factor đang hoạt động. Vì `upsertPendingTotp` đặt `confirmed`
   *   về false mà cổng đăng nhập chỉ nhìn cờ đó, một lần ghi đè vô điều
   *   kiện sẽ tắt MFA ngay lập tức và làm authenticator hiện tại thành
   *   vô dụng — phiên bị lộ là đủ để gỡ im lặng lớp bảo vệ đang bật.
   *   Do đó bước này áp CỔNG TÁI XÁC THỰC cùng khuôn với luồng tắt MFA:
   *   người gọi phải trình mã TOTP hiện tại (đúng với secret đang hoạt
   *   động) TRƯỚC khi ghi đè. Thiếu mã ⇒ `auth.mfa_reauth_required`;
   *   mã sai ⇒ `auth.mfa_invalid_code`; cả hai trường hợp đều từ chối
   *   khi CHƯA chạm vào bản ghi nên factor cũ giữ nguyên vẹn (secret
   *   cũ, `confirmed` vẫn true, MFA vẫn bật). Mã đúng ⇒ ghi đè như
   *   luồng setup thường: secret mới ở trạng thái chờ xác nhận, chờ
   *   bước confirm kích hoạt lại.
   *
   * @param currentCode Mã TOTP hiện tại — chỉ bắt buộc khi factor đang bật.
   */
  async setup(userId: string, username: string, currentCode?: string): Promise<{ secret: string; otpauthUrl: string }> {
    const existing = await this.repo.getTotpByUserId(userId);
    if (existing?.confirmed) {
      if (!currentCode) {
        throw new UnauthorizedException({ message: 'Current two-factor authentication code is required to replace the active authenticator', code: 'auth.mfa_reauth_required' });
      }
      if (!(await this.verifyCode(this.decryptSecret(existing.secretEncrypted), currentCode))) {
        throw new UnauthorizedException({ message: 'Invalid two-factor authentication code', code: 'auth.mfa_invalid_code' });
      }
    }
    const secret = generateSecret();
    await this.repo.upsertPendingTotp(userId, this.encryptSecret(secret));
    const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: username, secret });
    return { secret, otpauthUrl };
  }

  /**
   * Bước confirm: mã đúng với secret đang chờ ⇒ kích hoạt MFA cho user.
   * Chưa setup thì báo `auth.mfa_not_setup`; mã sai thì `auth.mfa_invalid_code`.
   */
  async confirm(userId: string, code: string): Promise<void> {
    const row = await this.repo.getTotpByUserId(userId);
    if (!row) throw new BadRequestException({ message: 'TOTP has not been set up for this account', code: 'auth.mfa_not_setup' });
    if (!(await this.verifyCode(this.decryptSecret(row.secretEncrypted), code))) {
      throw new UnauthorizedException({ message: 'Invalid two-factor authentication code', code: 'auth.mfa_invalid_code' });
    }
    await this.repo.confirmTotp(userId);
  }

  /**
   * Tắt MFA: chỉ chủ tài khoản có authenticator hiện tại (mã đúng với
   * secret đang bật) mới tắt được; tắt xong bản ghi secret bị xoá hẳn.
   */
  async disable(userId: string, code: string): Promise<void> {
    const row = await this.repo.getTotpByUserId(userId);
    if (!row?.confirmed) throw new BadRequestException({ message: 'Two-factor authentication is not enabled for this account', code: 'auth.mfa_not_enabled' });
    if (!(await this.verifyCode(this.decryptSecret(row.secretEncrypted), code))) {
      throw new UnauthorizedException({ message: 'Invalid two-factor authentication code', code: 'auth.mfa_invalid_code' });
    }
    await this.repo.deleteTotp(userId);
  }

  /**
   * Kiểm chứng mã ở bước đăng nhập hai lớp: false khi user chưa bật MFA
   * hoặc mã sai.
   */
  async verifyForUser(userId: string, code: string): Promise<boolean> {
    const row = await this.repo.getTotpByUserId(userId);
    if (!row?.confirmed) return false;
    return this.verifyCode(this.decryptSecret(row.secretEncrypted), code);
  }

  /** Quản trị gỡ MFA cho user (mất authenticator): xoá hẳn bản ghi TOTP. */
  async resetForUser(userId: string): Promise<void> {
    await this.repo.deleteTotp(userId);
  }
}
