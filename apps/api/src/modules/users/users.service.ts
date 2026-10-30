import { BadRequestException, ConflictException, ForbiddenException, forwardRef, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MyAccessView } from '@lms/contracts';
import { and, eq } from 'drizzle-orm';
import { badgeIssued, learningPlans } from '../../db/schema';
import { OutboxService } from '../../infra/events/outbox.service';
import type { ContextRow } from '../access/access.repository';
import { ContextsService } from '../access/contexts.service';
import { AuthRepository } from '../auth/auth.repository';
import { CredentialBridgeService } from '../auth/better-auth/credential-bridge.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { PlanLimitsService } from '../access/plan-limits.service';
import { RolesService } from '../access/roles.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { PasswordService } from './password.service';
import { UsersRepository, type UserListFilter, type UserRow } from './users.repository';

export const USER_COMPONENT = 'core_user';
export const USER_AREA = 'user';

export interface UserProfileView {
  id: string; username: string; firstName: string; lastName: string;
  email?: string; // trường danh tính — chỉ xuất hiện khi người xem được phép thấy nó
  suspended: boolean; deleted: boolean; isGuest: boolean; forcePasswordChange: boolean;
  lastLogin: Date | null; createdAt: Date;
  customFields: { shortName: string; name: string; type: string; value: string | null }[];
}

export function normalizeIdentity(value: string): string { return value.trim().toLowerCase(); }

/** Facade của UsersModule. Xác thực ≠ ghi danh ≠ gán role: service này chỉ sở hữu dữ liệu danh tính/hồ sơ. */
@Injectable()
/**
 * Quản lý tài khoản người dùng: tạo, hồ sơ, đình chỉ, xoá mềm và tuỳ chọn cá nhân.
 * Đối chiếu Moodle: lib/moodlelib.php (user_create_user, user_update_user) và user/lib.php.
 * Bất biến: user bị xoá là xoá mềm (deleted=1) để giữ toàn vẹn tham chiếu lịch sử;
 * username/email là duy nhất trong số user chưa xoá.
 */
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repo: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly customFields: CustomFieldsService,
    private readonly outbox: OutboxService,
    private readonly planLimits: PlanLimitsService,
    // forwardRef: một cạnh của vòng provider với cầu nối/BetterAuth/
    // lockout (xem ghi chú tại CredentialBridgeService).
    @Inject(forwardRef(() => CredentialBridgeService))
    private readonly credentialBridge: CredentialBridgeService,
    // forwardRef: một cạnh nữa của vòng module UsersModule ↔
    // AuthModule (AuthModule cần UsersService; service này cần
    // AuthRepository để thu hồi family refresh mỗi lần đặt mật
    // khẩu qua updateUser). AuthRepository chỉ phụ thuộc tầng dữ
    // liệu nên chuỗi provider kết thúc ở đó.
    @Inject(forwardRef(() => AuthRepository))
    private readonly authRepository: AuthRepository,
  ) {}

  /**
   * Đồng bộ dòng credential của Better Auth sau một lần ghi mật khẩu
   * phía hệ cũ (GĐ2 chặng 2.6): cầu nối tự no-op khi Better Auth tắt
   * nên đường cũ không đổi hành vi. Lỗi đồng bộ KHÔNG được làm hỏng
   * thao tác nghiệp vụ vừa ghi thành công (hệ cũ vẫn là nguồn sự thật
   * trong thời gian cùng tồn tại) — nhưng phải kêu to trong log thay
   * vì âm thầm lệch credential.
   */
  private async syncCredential(userId: string): Promise<void> {
    try {
      await this.credentialBridge.syncCredentialPassword(userId);
    } catch (err) {
      this.logger.warn(`credential sync failed for user ${userId}: ${String(err)}`);
    }
  }

  /**
   * Toàn cảnh quyền của chính người gọi (tự phục vụ, không cần capability
   * quản trị): có phải site admin không, các gán vai trò của họ kèm thông
   * tin context, và capability ĐÃ PHÂN GIẢI tại từng context liên quan
   * (context được gán vai trò, mọi tổ tiên của chúng và context hệ thống).
   * Kết quả phân giải dùng cùng ngữ nghĩa của PermissionEvaluator nên
   * PROHIBIT/PREVENT và vai trò mặc định `user`/`guest` được tính đúng
   * như khi chặn route — giao diện dùng dữ liệu này để chỉ hiển thị chức
   * năng người dùng thật sự thao tác được thay vì dò quyền bằng request
   * thử.
   *
   * Luồng tính (theo lô — KHÔNG gọi `hasCapability` lặp cho từng cặp
   * context × capability nữa vì mỗi lần gọi như vậy tốn vài truy vấn
   * Postgres ngay cả khi cache nóng, làm một request ảnh chụp quyền
   * phát sinh hàng nghìn truy vấn):
   *   1. Nạp một lần các gán vai trò của người dùng và toàn bộ vai trò.
   *   2. Nạp theo lô mọi context liên quan: context của các gán vai
   *      (khử trùng theo id — nhiều gán vai cùng một context chỉ đọc
   *      một lần) rồi toàn bộ tổ tiên trên `path` của chúng, mỗi nhóm
   *      đúng một truy vấn. Thứ tự hợp nhất tập context liên quan giữ
   *      nguyên như trước: context hệ thống trước, rồi với từng gán
   *      vai theo thứ tự liệt kê, các context trên path của nó theo
   *      thứ tự lá → gốc, context đã có thì không chèn lại.
   *   3. Phân giải capability cho mọi context liên quan trong một lần
   *      qua `PermissionEvaluator.resolveCapabilitiesForContexts`
   *      (nạp theo lô gán vai/override/cổng tenant rồi tính trong bộ
   *      nhớ bằng đúng hàm thuần phân giải — kết quả bằng đúng phép
   *      phân giải từng cặp trước đây).
   */
  async getMyAccess(userId: string, opts?: { isGuest?: boolean }): Promise<MyAccessView> {
    const isSiteAdmin = await this.evaluator.isSiteAdmin(userId);
    const assignmentRows = (await this.roles.listAssignments({ userId: userId })) as {
      id: string; roleId: string; contextId: string;
    }[];
    const roleById = new Map((await this.roles.listRoles()).map((r) => [r.id, r]));

    // Bước 2a: nạp theo lô các context của chính các gán vai (khử trùng
    // theo id). Một gán vai trỏ tới context không còn tồn tại vẫn ném
    // access.context_not_found như đường đọc từng context trước đây.
    const contextById = new Map<string, ContextRow>();
    const assignmentContextIds = [...new Set(assignmentRows.map((r) => r.contextId))];
    for (const row of await this.contexts.getContextsByIds(assignmentContextIds)) {
      contextById.set(row.id, row);
    }
    // Bước 2b: nạp theo lô mọi tổ tiên còn thiếu trên path của các
    // context đó — tổ tiên của một tổ tiên cũng nằm trên cùng path nên
    // một lần nạp này khép kín toàn bộ cây liên quan.
    const ancestorIds = new Set<string>();
    for (const id of assignmentContextIds) {
      const ctx = contextById.get(id);
      if (!ctx) throw new NotFoundException({ message: `Context ${id} not found`, code: 'access.context_not_found' });
      for (const pathId of ctx.path.split('/').filter(Boolean)) {
        if (!contextById.has(pathId)) ancestorIds.add(pathId);
      }
    }
    for (const row of await this.contexts.getContextsByIds([...ancestorIds])) {
      contextById.set(row.id, row);
    }

    const assignments: MyAccessView['assignments'] = [];
    const relatedContexts = new Map<string, ContextRow>();
    const system = await this.contexts.ensureSystemContext();
    relatedContexts.set(system.id, system);
    if (!contextById.has(system.id)) contextById.set(system.id, system);
    for (const row of assignmentRows) {
      const ctx = contextById.get(row.contextId)!;
      const role = roleById.get(row.roleId);
      assignments.push({
        id: row.id,
        roleId: row.roleId,
        roleShortname: role?.shortName ?? '',
        roleName: role?.name ?? '',
        contextId: ctx.id,
        contextLevel: ctx.contextLevel,
        contextPath: ctx.path,
        instanceId: ctx.instanceId,
      });
      // Path vật chất hoá lưu từ gốc xuống lá; duyệt ngược lại (lá →
      // gốc) như getPathContexts để thứ tự hợp nhất khớp trước đây.
      for (const pathId of ctx.path.split('/').filter(Boolean).reverse()) {
        const pathCtx = contextById.get(pathId);
        if (pathCtx) relatedContexts.set(pathCtx.id, pathCtx);
      }
    }

    // Bước 3: phân giải theo lô cho mọi context liên quan trong một lần.
    const related = [...relatedContexts.values()];
    const resolvedByContext = await this.evaluator.resolveCapabilitiesForContexts(userId, related, contextById, opts);
    const contexts: MyAccessView['contexts'] = related.map((ctx) => ({
      contextId: ctx.id,
      contextLevel: ctx.contextLevel,
      contextPath: ctx.path,
      capabilities: resolvedByContext.get(ctx.id) ?? [],
    }));
    // Cờ hiện vật học tập (issue #176, nhánh A của dấu chân học tập):
    // hai EXISTS qua index sẵn có — badge_issued_user_id_idx (chỉ tính
    // huy hiệu chưa thu hồi) và learning_plans_user_id_idx — không thêm
    // schema, không thêm request phía web (cờ đi kèm ảnh chụp quyền).
    const [liveBadge] = await this.repo.dbHandle
      .select({ id: badgeIssued.id }).from(badgeIssued)
      .where(and(eq(badgeIssued.userId, userId), eq(badgeIssued.revoked, false))).limit(1);
    const [ownPlan] = await this.repo.dbHandle
      .select({ id: learningPlans.id }).from(learningPlans)
      .where(eq(learningPlans.userId, userId)).limit(1);
    const hasLearnerArtifacts = !!liveBadge || !!ownPlan;
    return { userId, isSiteAdmin, assignments, contexts, hasLearnerArtifacts };
  }

  /**
   * Tạo user: kiểm chính sách mật khẩu, hash, chống trùng username/email (user.username_taken, user.email_taken).
   */
  async createUser(input: { username: string; email: string; password: string; firstName?: string; lastName?: string; forcePasswordChange?: boolean; customFields?: Record<string, string> }): Promise<UserRow> {
    const username = normalizeIdentity(input.username);
    const email = normalizeIdentity(input.email);
    if (await this.repo.getByUsername(username)) throw new ConflictException({ message: `Username ${username} is taken`, code: 'user.username_taken' });
    if (await this.repo.getByEmail(email)) throw new ConflictException({ message: `Email ${email} is taken`, code: 'user.email_taken' });
    if (input.customFields) await this.customFields.validateValuesForInstance(USER_COMPONENT, USER_AREA, input.customFields);
    const policyErrors = this.passwords.validatePolicy(input.password);
    if (policyErrors.length) throw new BadRequestException({ message: policyErrors.join('; '), code: 'user.password_policy' });
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertUser({
        username, email, passwordHash,
        firstName: input.firstName ?? '', lastName: input.lastName ?? '',
        forcePasswordChange: input.forcePasswordChange ?? false,
      }, tx);
      await this.outbox.enqueue(tx, { aggregate: 'user', type: 'user_created', payload: { userId: created.id, username } });
      return created;
    });
    await this.contexts.createContext(CONTEXT_LEVELS.USER, user.id, (await this.contexts.ensureSystemContext()).id);
    if (input.customFields) await this.customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, user.id, input.customFields);
    // Chặng 2.6 (issue #7): user tạo ở đây đăng nhập được qua Better
    // Auth ngay — dòng credential sinh cùng hash vừa ghi.
    await this.syncCredential(user.id);
    return user;
  }

  /** Tài khoản guest đặc biệt: không đăng nhập bằng mật khẩu cho mục đích ghi danh, không bao giờ được gán role trực tiếp (luật của Moodle). */
  /**
   * Đảm bảo tài khoản khách (guest) tồn tại cho các luồng truy cập công khai; idempotent.
   */
  async ensureGuestUser(): Promise<UserRow> {
    const existing = await this.repo.getByUsername('guest');
    if (existing) return existing;
    const guest = await this.repo.insertUser({ username: 'guest', email: 'guest@localhost', passwordHash: null, firstName: 'Guest', lastName: 'User', isGuest: true });
    await this.contexts.createContext(CONTEXT_LEVELS.USER, guest.id, (await this.contexts.ensureSystemContext()).id);
    return guest;
  }

  /**
   * Lấy user theo id; ném user.not_found khi vắng.
   */
  async getUser(id: string): Promise<UserRow> {
    const row = await this.repo.getById(id);
    if (!row) throw new NotFoundException({ message: `User ${id} not found`, code: 'user.not_found' });
    return row;
  }
  /**
   * Tạo tài khoản từ danh tính ngoài đã xác thực (đăng nhập xã hội —
   * `create_new_confirmed_account` của auth_oauth2): nhà cung cấp đã chứng
   * minh quyền sở hữu email nên tài khoản được xác nhận ngay, KHÔNG có mật
   * khẩu khả dụng (`passwordHash = null` như tài khoản guest — đăng nhập
   * bằng mật khẩu luôn thất bại cho tới khi user tự đặt mật khẩu qua các
   * luồng thường). Username suy từ phần local của email, thêm hậu tố số
   * khi trùng; email trùng một tài khoản sẵn có là lỗi của phía gọi (luồng
   * OAuth phải khớp email trước khi tới đây).
   */
  async createExternalUser(input: { email: string; firstName?: string; lastName?: string }): Promise<UserRow> {
    const email = normalizeIdentity(input.email);
    if (await this.repo.getByEmail(email)) throw new ConflictException({ message: `Email ${email} is taken`, code: 'user.email_taken' });
    const base = email.split('@')[0]!.replace(/[^a-z0-9._-]+/g, '.').replace(/^\.+|\.+$/g, '') || 'user';
    let username = base;
    for (let suffix = 2; await this.repo.getByUsername(username); suffix += 1) username = `${base}${suffix}`;
    const user = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertUser({
        username, email, passwordHash: null,
        firstName: input.firstName ?? '', lastName: input.lastName ?? '',
        forcePasswordChange: false,
      }, tx);
      await this.outbox.enqueue(tx, { aggregate: 'user', type: 'user_created', payload: { userId: created.id, username } });
      return created;
    });
    await this.contexts.createContext(CONTEXT_LEVELS.USER, user.id, (await this.contexts.ensureSystemContext()).id);
    return user;
  }

  /**
   * Lấy user theo username; ném user.not_found khi vắng.
   */
  async getByUsername(username: string): Promise<UserRow | undefined> { return this.repo.getByUsername(normalizeIdentity(username)); }
  /**
   * Lấy user theo email (đã chuẩn hoá); trả undefined khi không có — dùng
   * cho việc khớp tài khoản khi đăng nhập xã hội.
   */
  async getByEmail(email: string): Promise<UserRow | undefined> { return this.repo.getByEmail(normalizeIdentity(email)); }
  /**
   * Lấy user theo id, trả undefined thay vì ném lỗi.
   */
  async getByIdOrUndefined(id: string): Promise<UserRow | undefined> { return this.repo.getById(id); }

  /** Nhiều user theo id trong một lần gọi (báo cáo/export dùng để gắn thông tin người học vào dòng dữ liệu). */
  async getUsersByIds(ids: string[]): Promise<UserRow[]> { return this.repo.getByIds(ids); }

  /**
   * Danh sách user có tìm kiếm/phân trang, kèm lọc trạng thái và sắp xếp theo
   * hợp đồng truy vấn: không truyền trạng thái thì ẩn tài khoản đã xoá, không
   * truyền trường sắp xếp thì giữ thứ tự theo id — đúng hành vi mặc định vốn có.
   */
  async listUsers(search: string | undefined, page = 1, pageSize = 20, filter: UserListFilter = {}): Promise<{ users: UserRow[]; total: number; page: number; pageSize: number }> {
    const { rows, total } = await this.repo.search(search, page, pageSize, filter);
    return { users: rows, total, page, pageSize };
  }

  /**
   * Cập nhật hồ sơ (họ tên, email, …) với kiểm tra trùng email.
   *
   * Luồng riêng khi đầu vào có trường `password` (đặt mật khẩu qua
   * đường sửa hồ sơ — tách bạch với luồng đổi mật khẩu chính thống):
   * 1. Người sửa là chính chủ tài khoản (`actorId === id`) → TỪ CHỐI
   *    bằng `user.password_self_change_forbidden`. Hàm này không có
   *    tham số mật khẩu hiện tại nên không tồn tại bước tái xác thực;
   *    nếu cho qua, một phiên bị đánh cắp là đủ để đổi mật khẩu và
   *    chiếm tài khoản. Tự đổi mật khẩu chỉ đi qua luồng có tái xác
   *    thực bằng mật khẩu hiện tại (AuthService.changePassword).
   * 2. Người sửa là người khác (quản trị viên — đã qua cổng
   *    `user:update` tại assertCanUpdateProfile): kiểm chính sách →
   *    băm → ghi hash trong transaction kèm sự kiện outbox → đồng bộ
   *    credential sang hệ đăng nhập thứ hai → THU HỒI mọi family
   *    refresh của tài khoản đích bằng đúng cơ chế
   *    AuthRepository.revokeAllForUser của luồng chính thống, để
   *    phiên cũ của tài khoản đích (kể cả phiên của kẻ đang chiếm
   *    tài khoản) không còn xoay được token mới.
   *
   * @param actorId Định danh người sửa, chỉ đường HTTP (controller
   * sửa hồ sơ) truyền vào. Đường nội bộ đã tái xác thực trước khi
   * gọi hàm này (changePassword) không truyền actorId và tự thu hồi
   * family sau đó; bước thu hồi tại đây với đường đó là idempotent
   * (đánh dấu thu hồi hai lần cho cùng kết quả).
   */
  async updateUser(id: string, input: { email?: string; firstName?: string; lastName?: string; password?: string; customFields?: Record<string, string> }, actorId?: string): Promise<UserRow> {
    // Chốt chặn tự đặt mật khẩu: phải chạy trước mọi bước ghi nào,
    // kể cả kiểm tra dữ liệu khác, để yêu cầu bị từ chối nguyên vẹn.
    if (input.password !== undefined && actorId !== undefined && actorId === id) {
      throw new ForbiddenException({ message: 'Use the change-password flow with your current password to change your own password', code: 'user.password_self_change_forbidden' });
    }
    const user = await this.getUser(id);
    if (input.customFields) await this.customFields.validateValuesForInstance(USER_COMPONENT, USER_AREA, input.customFields);
    if (user.deleted) throw new BadRequestException({ message: 'Cannot update a deleted user', code: 'user.deleted' });
    const patch: Partial<typeof import('../../db/schema').users.$inferInsert> = {};
    if (input.email !== undefined) {
      const email = normalizeIdentity(input.email);
      const clash = await this.repo.getByEmail(email);
      if (clash && clash.id !== id) throw new ConflictException({ message: `Email ${email} is taken`, code: 'user.email_taken' });
      patch.email = email;
    }
    if (input.firstName !== undefined) patch.firstName = input.firstName;
    if (input.lastName !== undefined) patch.lastName = input.lastName;
    if (input.password !== undefined) {
      const errors = this.passwords.validatePolicy(input.password);
      if (errors.length) throw new BadRequestException({ message: errors.join('; '), code: 'user.password_policy' });
      patch.passwordHash = await this.passwords.hash(input.password);
      patch.forcePasswordChange = false;
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUser(id, patch, tx);
      await this.outbox.enqueue(tx, { aggregate: 'user', type: 'user_updated', payload: { userId: id } });
    });
    // Chặng 2.6 (issue #7): mật khẩu vừa đặt lại ở hệ cũ cũng là mật
    // khẩu của dòng credential — hai hệ không bao giờ lệch mật khẩu.
    // Kèm theo: mật khẩu vừa bị đặt lại thì mọi family refresh đã cấp
    // trước đó của tài khoản đích phải chết ngay (cùng cơ chế của
    // luồng đổi mật khẩu chính thống) — nếu không, phiên cũ vẫn tiếp
    // tục mint access token mới dù mật khẩu đã đổi.
    if (input.password !== undefined) {
      await this.syncCredential(id);
      await this.authRepository.revokeAllForUser(id);
    }
    if (input.customFields) await this.customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, id, input.customFields);
    return this.getUser(id);
  }

  /**
   * Đình chỉ hoặc khôi phục tài khoản; user bị đình chỉ không đăng nhập được.
   */
  async setSuspended(id: string, suspended: boolean): Promise<UserRow> {
    const user = await this.getUser(id);
    if (user.isGuest) throw new BadRequestException({ message: 'The guest account cannot be suspended', code: 'user.guest_immutable' });
    // Điểm chặn SLOT GÓI TRUNG TÂM (issue #189 — đặc tả slot đã
    // duyệt): BỎ đình chỉ một tài khoản đang bị đình chỉ là hành
    // động "kích hoạt lại tài khoản giáo viên đang đình chỉ" — tài
    // khoản được đếm trở lại ở mọi tenant khách hàng mà họ là thành
    // viên `active` có vai trò giảng dạy; tenant nào đã chạm hạn mức
    // hiệu lực thì chặn toàn bộ hành động trước khi ghi. Đình chỉ
    // (chiều ngược lại) luôn được phép vì chỉ làm giảm số slot.
    if (!suspended && user.suspended) {
      await this.planLimits.assertUserReactivationWithinSlotLimits(id);
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUser(id, { suspended }, tx);
      await this.outbox.enqueue(tx, { aggregate: 'user', type: suspended ? 'user_suspended' : 'user_unsuspended', payload: { userId: id } });
    });
    return this.getUser(id);
  }

  /** Xoá mềm (ngữ nghĩa Moodle): dòng vẫn ở lại để truy vết log/điểm, được đánh dấu đã xoá và danh tính bị xáo trộn để các giá trị gốc có thể được dùng lại. */
  /**
   * Xoá mềm tài khoản.
   */
  async deleteUser(id: string): Promise<UserRow> {
    const user = await this.getUser(id);
    if (user.isGuest) throw new BadRequestException({ message: 'The guest account cannot be deleted', code: 'user.guest_immutable' });
    if (user.deleted) return user;
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUser(id, {
        deleted: true, suspended: true,
        username: `${user.username}.deleted${id}`, email: `${user.email}.deleted${id}`,
      }, tx);
      await this.outbox.enqueue(tx, { aggregate: 'user', type: 'user_deleted', payload: { userId: id } });
    });
    return this.getUser(id);
  }

  /**
   * Ghi nhận lần đăng nhập thành công (first/last access, IP).
   */
  async recordLogin(id: string): Promise<void> { await this.repo.updateUser(id, { lastLogin: new Date() }); }
  /**
   * Gỡ cờ bắt buộc đổi mật khẩu sau khi user đã đổi.
   */
  async clearForcePasswordChange(id: string): Promise<void> { await this.repo.updateUser(id, { forcePasswordChange: false }); }
  /**
   * Xác thực mật khẩu của user (dùng cho auth và đổi mật khẩu).
   */
  async verifyPassword(user: UserRow, password: string): Promise<boolean> {
    if (!user.passwordHash) return false;
    return this.passwords.verify(user.passwordHash, password);
  }
  /**
   * Ghi tuỳ chọn cá nhân.
   */
  async setPreference(userId: string, name: string, value: string | null): Promise<void> { return this.repo.setPreference(userId, name, value); }
  /**
   * Đọc tuỳ chọn cá nhân.
   */
  async getPreference(userId: string, name: string): Promise<string | null | undefined> { return this.repo.getPreference(userId, name); }

  /**
   * View hồ sơ với luật riêng tư theo capability của Moodle: các trường danh tính
   * (email) chỉ được phơi bày cho chủ sở hữu, admin của site, hoặc người xem nắm giữ
   * `site:viewuseridentity` — được thực thi tại đây, không phải trong UI.
   */
  /**
   * Dựng dữ liệu hiển thị hồ sơ: email chỉ lộ khi người xem có capability xem định danh.
   */
  async getProfileView(targetId: string, viewerId: string): Promise<UserProfileView> {
    const user = await this.getUser(targetId);
    const views = await this.getProfileViews([user], viewerId);
    return views[0]!;
  }

  /**
   * View hồ sơ của NHIỀU user cho cùng một người xem, nạp theo lô
   * (DL-07, issue #489): context user của cả trang tra một truy vấn;
   * context hệ thống và quyền xem định danh ở đó tính một lần;
   * quyền xem định danh tại từng context user phân giải MỘT lần theo
   * lô qua `resolveCapabilitiesForContexts` — phép phân giải đã được
   * chứng minh tương đương `hasCapability` theo từng context (chỉ
   * khác là không qua cache Redis); giá trị trường tuỳ chỉnh nạp một
   * lượt cho cả trang. Thứ tự view giữ đúng thứ tự user đầu vào và
   * luật lộ email giữ nguyên từng người: chính chủ, hoặc có quyền
   * xem định danh tại context của user đó, hoặc tại context hệ
   * thống — email chỉ xuất hiện trong view khi một trong ba đúng.
   */
  async getProfileViews(targets: UserRow[], viewerId: string): Promise<UserProfileView[]> {
    if (!targets.length) return [];
    const systemCtx = await this.contexts.ensureSystemContext();
    const userCtxs = await this.contexts.getByLevelInstances(CONTEXT_LEVELS.USER, targets.map((u) => u.id));
    const ctxByUserId = new Map<string, ContextRow>();
    for (const ctx of userCtxs) {
      if (ctx.instanceId && !ctxByUserId.has(ctx.instanceId)) ctxByUserId.set(ctx.instanceId, ctx);
    }
    const canSeeAtSystem = await this.evaluator.hasCapability(viewerId, 'site:viewuseridentity', systemCtx.id);
    const capsByContextId = userCtxs.length
      ? await this.evaluator.resolveCapabilitiesForContexts(
        viewerId, userCtxs, new Map(userCtxs.map((c) => [c.id, c])),
      )
      : new Map<string, string[]>();
    const customByUser = await this.customFields.getValuesForInstances(
      USER_COMPONENT, USER_AREA, targets.map((u) => u.id),
    );
    return targets.map((user) => {
      const userCtx = ctxByUserId.get(user.id);
      const canSeeIdentity = viewerId === user.id
        || (userCtx ? (capsByContextId.get(userCtx.id) ?? []).includes('site:viewuseridentity') : false)
        || canSeeAtSystem;
      const custom = customByUser.get(user.id) ?? [];
      return {
        id: user.id, username: user.username, firstName: user.firstName, lastName: user.lastName,
        ...(canSeeIdentity ? { email: user.email } : {}),
        suspended: user.suspended, deleted: user.deleted, isGuest: user.isGuest,
        forcePasswordChange: user.forcePasswordChange, lastLogin: user.lastLogin, createdAt: user.createdAt,
        customFields: custom.map((c) => ({ shortName: c.field.shortName, name: c.field.name, type: c.field.type, value: c.value })),
      };
    });
  }

  /** Hàm hỗ trợ guard cho việc sửa hồ sơ: tự phục vụ hoặc người nắm giữ user:update. */
  /**
   * Chặn cập nhật hồ sơ người khác khi thiếu capability user:update.
   */
  async assertCanUpdateProfile(actorId: string, targetId: string): Promise<void> {
    if (actorId === targetId) return;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(actorId, 'user:update', systemCtx.id))) {
      throw new ForbiddenException({ message: 'Missing capability user:update', code: 'access.capability_denied' });
    }
  }
}
