import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MyAccessView } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { CAPABILITY_DEFINITIONS, CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { PasswordService } from './password.service';
import { UsersRepository, type UserRow } from './users.repository';

export const USER_COMPONENT = 'core_user';
export const USER_AREA = 'user';

export interface UserProfileView {
  id: string; username: string; firstname: string; lastname: string;
  email?: string; // identity field — only present when the viewer may see it
  suspended: boolean; deleted: boolean; isGuest: boolean; forcePasswordChange: boolean;
  lastlogin: Date | null; timecreated: Date;
  customFields: { shortname: string; name: string; type: string; value: string | null }[];
}

export function normalizeIdentity(value: string): string { return value.trim().toLowerCase(); }

/** UsersModule facade. Authentication ≠ enrolment ≠ role assignment: this service only owns identity/profile data. */
@Injectable()
/**
 * Quản lý tài khoản người dùng: tạo, hồ sơ, đình chỉ, xoá mềm và tuỳ chọn cá nhân.
 * Đối chiếu Moodle: lib/moodlelib.php (user_create_user, user_update_user) và user/lib.php.
 * Bất biến: user bị xoá là xoá mềm (deleted=1) để giữ toàn vẹn tham chiếu lịch sử;
 * username/email là duy nhất trong số user chưa xoá.
 */
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly passwords: PasswordService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly customFields: CustomFieldsService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Toàn cảnh quyền của chính người gọi (tự phục vụ, không cần capability
   * quản trị): có phải site admin không, các gán vai trò của họ kèm thông
   * tin context, và capability ĐÃ PHÂN GIẢI tại từng context liên quan
   * (context được gán vai trò, mọi tổ tiên của chúng và context hệ thống).
   * Kết quả phân giải đi qua PermissionEvaluator nên PROHIBIT/PREVENT và
   * vai trò mặc định `user`/`guest` được tính đúng như khi chặn route —
   * giao diện dùng dữ liệu này để chỉ hiển thị chức năng người dùng thật
   * sự thao tác được thay vì dò quyền bằng request thử.
   */
  async getMyAccess(userId: string, opts?: { isGuest?: boolean }): Promise<MyAccessView> {
    const isSiteAdmin = await this.evaluator.isSiteAdmin(userId);
    const assignmentRows = (await this.roles.listAssignments({ userid: userId })) as {
      id: string; roleid: string; contextid: string;
    }[];
    const roleById = new Map((await this.roles.listRoles()).map((r) => [r.id, r]));

    const assignments: MyAccessView['assignments'] = [];
    const relatedContexts = new Map<string, { id: string; contextlevel: number; path: string }>();
    const system = await this.contexts.ensureSystemContext();
    relatedContexts.set(system.id, system);
    for (const row of assignmentRows) {
      const ctx = await this.contexts.getContext(row.contextid);
      const role = roleById.get(row.roleid);
      assignments.push({
        id: row.id,
        roleId: row.roleid,
        roleShortname: role?.shortname ?? '',
        roleName: role?.name ?? '',
        contextId: ctx.id,
        contextLevel: ctx.contextlevel,
        contextPath: ctx.path,
        instanceId: ctx.instanceid,
      });
      for (const pathCtx of await this.contexts.getPathContexts(ctx)) {
        relatedContexts.set(pathCtx.id, pathCtx);
      }
    }

    const contexts: MyAccessView['contexts'] = [];
    for (const ctx of relatedContexts.values()) {
      const capabilities: string[] = [];
      for (const def of CAPABILITY_DEFINITIONS) {
        if (await this.evaluator.hasCapability(userId, def.name, ctx.id, opts)) {
          capabilities.push(def.name);
        }
      }
      contexts.push({
        contextId: ctx.id,
        contextLevel: ctx.contextlevel,
        contextPath: ctx.path,
        capabilities,
      });
    }
    return { userId, isSiteAdmin, assignments, contexts };
  }

  /**
   * Tạo user: kiểm chính sách mật khẩu, hash, chống trùng username/email (user.username_taken, user.email_taken).
   */
  async createUser(input: { username: string; email: string; password: string; firstname?: string; lastname?: string; forcePasswordChange?: boolean; customFields?: Record<string, string> }): Promise<UserRow> {
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
        firstname: input.firstname ?? '', lastname: input.lastname ?? '',
        forcePasswordChange: input.forcePasswordChange ?? false,
      }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'user', type: 'user_created', payload: { userId: created.id, username } });
      return created;
    });
    await this.contexts.createContext(CONTEXT_LEVELS.USER, user.id, (await this.contexts.ensureSystemContext()).id);
    if (input.customFields) await this.customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, user.id, input.customFields);
    return user;
  }

  /** The special guest account: no password login for enrolment purposes, never assigned roles directly (Moodle rule). */
  /**
   * Đảm bảo tài khoản khách (guest) tồn tại cho các luồng truy cập công khai; idempotent.
   */
  async ensureGuestUser(): Promise<UserRow> {
    const existing = await this.repo.getByUsername('guest');
    if (existing) return existing;
    const guest = await this.repo.insertUser({ username: 'guest', email: 'guest@localhost', passwordHash: null, firstname: 'Guest', lastname: 'User', isGuest: true });
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
   * Lấy user theo username; ném user.not_found khi vắng.
   */
  async getByUsername(username: string): Promise<UserRow | undefined> { return this.repo.getByUsername(normalizeIdentity(username)); }
  /**
   * Lấy user theo id, trả undefined thay vì ném lỗi.
   */
  async getByIdOrUndefined(id: string): Promise<UserRow | undefined> { return this.repo.getById(id); }

  /**
   * Danh sách user có tìm kiếm/phân trang.
   */
  async listUsers(search: string | undefined, page = 1, pageSize = 20, includeDeleted = false): Promise<{ users: UserRow[]; total: number; page: number; pageSize: number }> {
    const { rows, total } = await this.repo.search(search, page, pageSize, includeDeleted);
    return { users: rows, total, page, pageSize };
  }

  /**
   * Cập nhật hồ sơ (họ tên, email, …) với kiểm tra trùng email.
   */
  async updateUser(id: string, input: { email?: string; firstname?: string; lastname?: string; password?: string; customFields?: Record<string, string> }): Promise<UserRow> {
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
    if (input.firstname !== undefined) patch.firstname = input.firstname;
    if (input.lastname !== undefined) patch.lastname = input.lastname;
    if (input.password !== undefined) {
      const errors = this.passwords.validatePolicy(input.password);
      if (errors.length) throw new BadRequestException({ message: errors.join('; '), code: 'user.password_policy' });
      patch.passwordHash = await this.passwords.hash(input.password);
      patch.forcePasswordChange = false;
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUser(id, patch, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'user', type: 'user_updated', payload: { userId: id } });
    });
    if (input.customFields) await this.customFields.setValuesForInstance(USER_COMPONENT, USER_AREA, id, input.customFields);
    return this.getUser(id);
  }

  /**
   * Đình chỉ hoặc khôi phục tài khoản; user bị đình chỉ không đăng nhập được.
   */
  async setSuspended(id: string, suspended: boolean): Promise<UserRow> {
    const user = await this.getUser(id);
    if (user.isGuest) throw new BadRequestException({ message: 'The guest account cannot be suspended', code: 'user.guest_immutable' });
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUser(id, { suspended }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'user', type: suspended ? 'user_suspended' : 'user_unsuspended', payload: { userId: id } });
    });
    return this.getUser(id);
  }

  /** Soft delete (Moodle semantics): the row stays for log/grade traceability, marked deleted and identity-mangled so the originals can be reused. */
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
      }, tx as never);
      await this.outbox.enqueue(tx as never, { aggregate: 'user', type: 'user_deleted', payload: { userId: id } });
    });
    return this.getUser(id);
  }

  /**
   * Ghi nhận lần đăng nhập thành công (first/last access, IP).
   */
  async recordLogin(id: string): Promise<void> { await this.repo.updateUser(id, { lastlogin: new Date() }); }
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
  async setPreference(userid: string, name: string, value: string | null): Promise<void> { return this.repo.setPreference(userid, name, value); }
  /**
   * Đọc tuỳ chọn cá nhân.
   */
  async getPreference(userid: string, name: string): Promise<string | null | undefined> { return this.repo.getPreference(userid, name); }

  /**
   * Profile view with Moodle's privacy-by-capability rule: identity fields
   * (email) are exposed only to the owner, site admins, or viewers holding
   * `moodle/site:viewuseridentity` — enforced here, not in the UI.
   */
  /**
   * Dựng dữ liệu hiển thị hồ sơ: email chỉ lộ khi người xem có capability xem định danh.
   */
  async getProfileView(targetId: string, viewerId: string): Promise<UserProfileView> {
    const user = await this.getUser(targetId);
    const userCtx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.USER, targetId);
    const systemCtx = await this.contexts.ensureSystemContext();
    const canSeeIdentity = viewerId === targetId
      || (userCtx ? await this.evaluator.hasCapability(viewerId, 'moodle/site:viewuseridentity', userCtx.id) : false)
      || (await this.evaluator.hasCapability(viewerId, 'moodle/site:viewuseridentity', systemCtx.id));
    const custom = await this.customFields.getValuesForInstance(USER_COMPONENT, USER_AREA, targetId);
    return {
      id: user.id, username: user.username, firstname: user.firstname, lastname: user.lastname,
      ...(canSeeIdentity ? { email: user.email } : {}),
      suspended: user.suspended, deleted: user.deleted, isGuest: user.isGuest,
      forcePasswordChange: user.forcePasswordChange, lastlogin: user.lastlogin, timecreated: user.timecreated,
      customFields: custom.map((c) => ({ shortname: c.field.shortname, name: c.field.name, type: c.field.type, value: c.value })),
    };
  }

  /** Guard helper for profile mutation: self-service or holders of moodle/user:update. */
  /**
   * Chặn cập nhật hồ sơ người khác khi thiếu capability moodle/user:update.
   */
  async assertCanUpdateProfile(actorId: string, targetId: string): Promise<void> {
    if (actorId === targetId) return;
    const systemCtx = await this.contexts.ensureSystemContext();
    if (!(await this.evaluator.hasCapability(actorId, 'moodle/user:update', systemCtx.id))) {
      throw new ForbiddenException({ message: 'Missing capability moodle/user:update', code: 'access.capability_denied' });
    }
  }
}
