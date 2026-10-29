import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermissionEvaluator } from '../../../src/modules/access/permission-evaluator.service';
import { UsersService } from '../../../src/modules/users/users.service';
import {
  adminToken, createTestApp, systemContextId,
} from '../../support/identity-access-helpers';

/**
 * Ca đánh giá capability của tài khoản khách (guest) qua evaluator —
 * tách từ `test/e2e/access/access-capability.e2e-spec.ts` (issue #483).
 *
 * Vì sao ca này thuộc tầng integration mà không viết lại qua HTTP:
 * act và assert của ca gọi thẳng `PermissionEvaluator.hasCapability`
 * với ngữ cảnh khách (`isGuest: true`) trên tài khoản khách do
 * `UsersService.ensureGuestUser` dựng. Không tồn tại tương đương HTTP
 * trực tiếp cho hành vi này — phiên khách qua HTTP là một danh tính
 * khác hẳn (đăng nhập bằng tài khoản khách dùng chung), còn tham số
 * `isGuest` của evaluator không lộ ra qua bất kỳ route nào. Ép viết
 * lại qua HTTP sẽ đổi hẳn hành vi đang kiểm chứng, nên ca giữ nguyên
 * văn tại tầng integration theo quy ước của dự án: test gọi trực tiếp
 * service là integration test. Các ca còn lại của file gốc vẫn ở tầng
 * e2e vì chúng kích hoạt qua HTTP thật.
 *
 * Fixture dựng qua các helper HTTP dùng chung (đăng nhập admin, đọc
 * context hệ thống) chỉ là bước chuẩn bị; tầng của test được quyết
 * định bởi act/assert ở trên.
 */
describe('Access: tài khoản khách chỉ được đánh giá qua vai khách (integration)', () => {
  let app: INestApplication;
  let systemId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const admin = await adminToken(app);
    systemId = await systemContextId(app, admin);
  });
  afterAll(async () => { await app.close(); });

  it('guest account evaluates through the guest role only', async () => {
    const users = app.get(UsersService);
    const evaluator = app.get(PermissionEvaluator);
    const guest = await users.ensureGuestUser();
    // Mặc định nguyên mẫu đã seed: vai guest ALLOW course:view tại hệ thống.
    expect(await evaluator.hasCapability(guest.id, 'course:view', systemId, { isGuest: true })).toBe(true);
    // …nhưng vai guest không cấp gì khác, và mặc định của người dùng đã xác thực KHÔNG được rò rỉ vào.
    expect(await evaluator.hasCapability(guest.id, 'user:viewdetails', systemId, { isGuest: true })).toBe(false);
  });
});
