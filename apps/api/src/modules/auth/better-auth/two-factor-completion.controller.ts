/**
 * Controller hoàn tất bước hai của đăng nhập Better Auth:
 * `POST /auth/two-factor/verify-totp` và
 * `POST /auth/two-factor/verify-backup-code`.
 *
 * Hai route này thuộc không gian `/api/v1/auth` của Better Auth
 * nhưng được mount chừa cho Nest xử lý (segment `two-factor` trong
 * `LEGACY_AUTH_SEGMENTS`) vì bước hoàn tất kiểm mã thẳng vào nguồn
 * trạng thái MFA duy nhất `user_totp` ở tầng service — xem
 * `two-factor-completion.service.ts` để biết toàn bộ lý do và giao
 * thức challenge. Đáp ứng viết tay qua `@Res()` để giữ đúng hình
 * của Better Auth mà client web (twoFactorClient) đang tiêu thụ:
 * thành công → 200 + thân `{ token, user }` + cookie phiên; lỗi →
 * status tương ứng + thân `{ code, message }`. Lỗi nghiệp vụ nằm ở
 * service dưới dạng `TwoFactorCompletionError`.
 */
import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../../common/public.decorator';
import {
  TwoFactorCompletionError,
  TwoFactorCompletionService,
  type TwoFactorCompletionResult,
} from './two-factor-completion.service';

@ApiTags('auth')
@Controller({ path: 'auth/two-factor', version: '1' })
export class TwoFactorCompletionController {
  constructor(private readonly completion: TwoFactorCompletionService) {}

  /**
   * POST /auth/two-factor/verify-totp — kiểm mã TOTP của challenge
   * trong cookie chờ; đúng mã thì đặt cookie phiên Better Auth và
   * xoá cookie chờ, sai mã/hết ngân sách thì trả lỗi theo ngữ nghĩa
   * Better Auth (xem service).
   */
  @Public()
  @Post('verify-totp')
  async verifyTotp(@Req() req: Request, @Body() body: unknown, @Res() res: Response): Promise<void> {
    const code = codeFromBody(body);
    if (code === null) {
      res.status(400).json({ code: 'INVALID_BODY', message: 'Code is required' });
      return;
    }
    try {
      const result = await this.completion.verifyTotp(req, code);
      this.writeSuccess(res, result);
    } catch (err) {
      this.writeError(res, err);
    }
  }

  /**
   * POST /auth/two-factor/verify-backup-code — sản phẩm không phát
   * mã dự phòng nên luôn từ chối bằng `INVALID_BACKUP_CODE` sau khi
   * qua cửa challenge (xem service).
   */
  @Public()
  @Post('verify-backup-code')
  async verifyBackupCode(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      await this.completion.verifyBackupCode(req);
    } catch (err) {
      this.writeError(res, err);
    }
  }

  /** Đặt cookie phiên theo thuộc tính của instance + xoá cookie chờ + trả thân phiên. */
  private writeSuccess(res: Response, result: TwoFactorCompletionResult): void {
    res.cookie(result.sessionCookieName, result.sessionCookieValue, {
      ...(result.sessionCookieAttributes as object),
      expires: result.sessionExpiresAt,
    });
    res.cookie(result.twoFactorCookieName, '', {
      ...(result.twoFactorCookieAttributes as object),
      maxAge: 0,
    });
    res.status(200).json(result.body);
  }

  /** Lỗi hoàn tất → thân `{ code, message }` đúng hình Better Auth; lỗi lạ → 500 chung, không lộ chi tiết. */
  private writeError(res: Response, err: unknown): void {
    if (err instanceof TwoFactorCompletionError) {
      res.status(err.status).json({ code: err.code, message: err.message });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
  }
}

/** Mã người dùng gửi: chỉ chấp nhận chuỗi khác rỗng sau khi cắt khoảng trắng; ngoài ra coi như thân không hợp lệ. */
function codeFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}
