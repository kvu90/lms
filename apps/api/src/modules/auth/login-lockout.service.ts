import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../users/users.service';
import { AuthRepository } from './auth.repository';

/** Mã lỗi khoá tạm thời — một giá trị duy nhất cho cả đáp ứng legacy (Nest) lẫn Better Auth (điểm 2.4, issue #7). */
export const AUTH_LOCKED_OUT_CODE = 'auth.locked_out';
/** Thông điệp khoá tạm thời — giữ nguyên văn của hệ legacy để đáp ứng hai đường không lệch nhau. */
export const AUTH_LOCKED_OUT_MESSAGE = 'Account is locked out due to failed login attempts';

/** Định danh đăng nhập ở tầng endpoint: `username` cho đường sign-in username, `email` cho đường sign-in email. */
export interface LoginIdentifier {
  username?: string;
  email?: string;
}

/**
 * Cổng hẹp mà tầng Better Auth dùng để áp chính sách lockout: factory
 * dựng instance (hàm thuần, ngoài vòng đời Nest) chỉ biết interface
 * này — cùng khuôn deps như `PasswordService`. Mọi hàm đều an toàn với
 * định danh không tồn tại: user không có thật thì không khoá và không
 * ghi (khớp hệ legacy, vốn ném `auth.invalid_credentials` trước khi
 * chạm tới bảng `login_attempts` khi username không tồn tại).
 */
export interface LockoutGuardPort {
  /** Tài khoản của định danh đăng nhập này có đang bị khoá tạm thời hay không. */
  isLoginLocked(identifier: LoginIdentifier): Promise<boolean>;
  /** Ghi một lần thử đăng nhập (thành công/thất bại + IP) vào bảng dùng chung `login_attempts`. */
  recordLoginAttempt(identifier: LoginIdentifier, success: boolean, ip?: string): Promise<void>;
}

/**
 * Chính sách khoá tạm thời theo tài khoản (authlib_test::test_lockout
 * semantics) — MỘT nguồn semantics duy nhất cho cả hệ legacy lẫn
 * Better Auth (điểm 2.4 trong hồ sơ Giai đoạn 2 của issue #7): tách ra
 * khỏi `AuthService` để endpoint hooks của Better Auth dùng chung đúng
 * bộ đếm trên bảng `login_attempts`, không tồn tại hai hệ đếm song song.
 *
 * Semantics giữ nguyên của hệ legacy: sau `LOCKOUT_THRESHOLD` lần thất
 * bại LIÊN TIẾP (chỉ tính các lần sau lần đăng nhập thành công gần
 * nhất) trong cửa sổ `LOCKOUT_WINDOW_MINUTES`, tài khoản bị khoá trong
 * `LOCKOUT_DURATION_MINUTES` kể từ lần thất bại chạm ngưỡng. Ngưỡng 0
 * tắt hẳn chính sách (hành vi Moodle).
 */
@Injectable()
export class LoginLockoutService implements LockoutGuardPort {
  constructor(
    private readonly repo: AuthRepository,
    // forwardRef: một cạnh của vòng provider với cầu nối/UsersService
    // (xem ghi chú tại CredentialBridgeService).
    @Inject(forwardRef(() => UsersService))
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  /**
   * User có đang bị khoá tạm thời do quá nhiều lần thất bại hay không.
   */
  async isLockedOut(userId: string): Promise<boolean> {
    const threshold = this.config.get<number>('LOCKOUT_THRESHOLD') ?? 5;
    if (threshold <= 0) return false; // khoá bị tắt khi ngưỡng bằng 0 (hành vi của Moodle)
    const windowMin = this.config.get<number>('LOCKOUT_WINDOW_MINUTES') ?? 20;
    const durationMin = this.config.get<number>('LOCKOUT_DURATION_MINUTES') ?? 30;
    const since = new Date(Date.now() - windowMin * 60_000);
    const failures = await this.repo.recentFailedAttempts(userId, since);
    if (failures.length < threshold) return false;
    const lastSuccess = await this.repo.lastSuccessfulAttemptAt(userId);
    const relevant = lastSuccess ? failures.filter((f) => f.attemptedAt > lastSuccess) : failures;
    if (relevant.length < threshold) return false;
    const thresholdHitAt = relevant[threshold - 1]!.attemptedAt.getTime();
    return Date.now() < thresholdHitAt + durationMin * 60_000;
  }

  /** Ghi một lần thử đăng nhập cho một user đã xác định được (đường legacy dùng trực tiếp). */
  async recordAttempt(v: { userId: string; username: string; success: boolean; ip?: string }): Promise<void> {
    await this.repo.recordAttempt(v);
  }

  /** Phân giải định danh đăng nhập sang user; vắng cả hai hoặc user không tồn tại thì undefined. */
  private async resolveUser(identifier: LoginIdentifier) {
    if (identifier.username) return this.users.getByUsername(identifier.username);
    if (identifier.email) return this.users.getByEmail(identifier.email);
    return undefined;
  }

  async isLoginLocked(identifier: LoginIdentifier): Promise<boolean> {
    const user = await this.resolveUser(identifier);
    if (!user || user.deleted) return false;
    return this.isLockedOut(user.id);
  }

  async recordLoginAttempt(identifier: LoginIdentifier, success: boolean, ip?: string): Promise<void> {
    const user = await this.resolveUser(identifier);
    if (!user) return;
    await this.repo.recordAttempt({ userId: user.id, username: user.username, success, ip });
  }
}
