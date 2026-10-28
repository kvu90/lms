import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CoursesService } from '../courses/courses.service';
import { IntegrationsRepository, type ServiceRow, type TokenRow } from './integrations.repository';

/** Định nghĩa một external function trong registry code: capability bắt buộc + cách resolve context. */
export interface ExternalFunctionDef {
  name: string;
  capability: string;
  /** Resolve contextId từ args; mặc định là system context. */
  resolveContext?: (args: Record<string, unknown>, ctx: ContextsService, courses: CoursesService) => Promise<string>;
  handler: (callerId: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** Băm token để lưu trữ — token thô chỉ trả về đúng một lần khi tạo. */
export function hashToken(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }

/**
 * Facade của IntegrationTokensModule (Moodle core_webservice, §2#21).
 * Service = tập function + token; mỗi function khai báo capability bắt buộc
 * kiểm tại context đã resolve. Token KHÔNG BAO GIỜ bypass capability của
 * user sở hữu token.
 */
@Injectable()
export class IntegrationsService {
  private readonly functions = new Map<string, ExternalFunctionDef>();

  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
  ) {
    this.registerBuiltinFunctions();
  }

  /** Đăng ký function vào registry — module khác đăng ký qua đây. */
  registerFunction(def: ExternalFunctionDef): void { this.functions.set(def.name, def); }
  listFunctions(): string[] { return [...this.functions.keys()]; }
  getFunction(name: string): ExternalFunctionDef | undefined { return this.functions.get(name); }

  private registerBuiltinFunctions(): void {
    this.registerFunction({
      name: 'core_course_get_courses',
      capability: 'course:view',
      resolveContext: async (_args, ctx) => (await ctx.ensureSystemContext()).id,
      handler: async () => this.courses.listCourses(),
    });
    this.registerFunction({
      name: 'core_course_get_course_content',
      capability: 'course:view',
      resolveContext: async (args, _ctx, courses) => courses.courseContextId(String(args.courseId)),
      handler: async (callerId, args) => {
        const content = await this.courses.getCourseContent(callerId, String(args.courseId));
        return { courseId: content.course.id, sections: content.sections.length };
      },
    });
    this.registerFunction({
      name: 'core_grades_update_grades',
      capability: 'grade:edit',
      resolveContext: async (args, _ctx, courses) => courses.courseContextId(String(args.courseId)),
      handler: async (_callerId, args) => ({ updated: true, courseId: String(args.courseId), note: 'grade write delegated to GradesModule in production wiring' }),
    });
  }

  // --- quản trị service/token (capability riêng ở controller/guard + kiểm tra ở service) ---

  private async requireManage(actorId: string): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'webservice:manage', sys.id);
  }

  async createService(actorId: string, input: { name: string; shortName: string; enabled?: boolean; functions?: string[] }): Promise<ServiceRow> {
    await this.requireManage(actorId);
    for (const fn of input.functions ?? []) {
      if (!this.functions.has(fn)) throw new BadRequestException({ message: `Unknown function ${fn}`, code: 'webservice.unknown_function' });
    }
    return this.repo.insertService({ name: input.name, shortName: input.shortName, enabled: input.enabled ?? true, functions: input.functions ?? [] });
  }
  async listServices(): Promise<ServiceRow[]> { return this.repo.listServices(); }
  async getService(id: string): Promise<ServiceRow> {
    const row = await this.repo.getService(id);
    if (!row) throw new NotFoundException({ message: `Service ${id} not found`, code: 'webservice.service_not_found' });
    return row;
  }
  async setServiceEnabled(actorId: string, id: string, enabled: boolean): Promise<ServiceRow> {
    await this.requireManage(actorId);
    await this.getService(id);
    await this.repo.updateService(id, { enabled });
    return this.getService(id);
  }

  /** Tạo token: trả token thô đúng một lần; DB chỉ lưu hash. */
  async createToken(actorId: string, input: { userId: string; serviceId: string; validUntil?: string; ipRestriction?: string }): Promise<{ token: string; row: TokenRow }> {
    await this.requireManage(actorId);
    await this.getService(input.serviceId);
    const raw = randomBytes(32).toString('hex');
    const row = await this.repo.insertToken({
      tokenHash: hashToken(raw), userId: input.userId, serviceId: input.serviceId,
      validUntil: input.validUntil ? new Date(input.validUntil) : null,
      ipRestriction: input.ipRestriction ?? null,
    });
    return { token: raw, row };
  }
  async listTokens(actorId: string): Promise<TokenRow[]> { await this.requireManage(actorId); return this.repo.listTokens(); }
  async revokeToken(actorId: string, id: string): Promise<TokenRow> {
    await this.requireManage(actorId);
    const row = await this.repo.getToken(id);
    if (!row) throw new NotFoundException({ message: `Token ${id} not found`, code: 'webservice.token_not_found' });
    await this.repo.updateToken(id, { revoked: true });
    return (await this.repo.getToken(id))!;
  }

  /**
   * Gọi function qua envelope thống nhất. Các bước kiểm tra theo thứ tự:
   * token tồn tại/không thu hồi/không hết hạn → chủ token còn hoạt động
   * (chưa xoá, không bị đình chỉ) → IP khớp → service enabled và chứa
   * function → capability của USER SỞ HỮU token tại context đã resolve.
   */
  async callFunction(input: { token: string; functionName: string; args?: Record<string, unknown>; ip?: string }): Promise<unknown> {
    const row = await this.repo.getTokenByHash(hashToken(input.token));
    if (!row || row.revoked) throw new UnauthorizedException({ message: 'Invalid or revoked token', code: 'webservice.invalid_token' });
    if (row.validUntil && row.validUntil < new Date()) throw new UnauthorizedException({ message: 'Token expired', code: 'webservice.token_expired' });
    // Trạng thái chủ token được kiểm tra tại lúc dùng (read-time), cùng khuôn
    // với mọi bề mặt xác thực khác (JWT, refresh token, phiên web, MCP đều
    // nạp lại trạng thái tài khoản ở mỗi request): chủ đã xoá hoặc đang bị
    // đình chỉ thì token mất hiệu lực ngay tại lời gọi này, dù bản thân token
    // chưa bị thu hồi và capability của chủ vẫn còn nguyên trong hệ phân
    // quyền. KHÔNG thu hồi cứng token khi đình chỉ — đình chỉ là trạng thái
    // khôi phục được, nên điểm kiểm này chỉ đọc trạng thái hiện tại của chủ
    // mà không đổi trạng thái dòng token: chủ được gỡ đình chỉ là token gọi
    // lại được ngay, không cần cấp token mới.
    const owner = await this.repo.getTokenOwnerState(row.userId);
    if (!owner || owner.deleted || owner.suspended) {
      throw new UnauthorizedException({ message: 'Token owner account is not active', code: 'webservice.owner_inactive' });
    }
    if (row.ipRestriction) {
      const allowed = row.ipRestriction.split(',').map((s) => s.trim());
      if (!input.ip || !allowed.includes(input.ip)) throw new ForbiddenException({ message: 'IP not allowed for this token', code: 'webservice.ip_denied' });
    }
    const service = await this.getService(row.serviceId);
    if (!service.enabled) throw new ForbiddenException({ message: 'Service is disabled', code: 'webservice.service_disabled' });
    const serviceFunctions = (service.functions as string[]) ?? [];
    if (!serviceFunctions.includes(input.functionName)) {
      throw new ForbiddenException({ message: `Function ${input.functionName} is not part of service ${service.shortName}`, code: 'webservice.function_not_in_service' });
    }
    const def = this.functions.get(input.functionName);
    if (!def) throw new NotFoundException({ message: `Unknown function ${input.functionName}`, code: 'webservice.unknown_function' });
    const args = input.args ?? {};
    const contextId = def.resolveContext ? await def.resolveContext(args, this.contexts, this.courses) : (await this.contexts.ensureSystemContext()).id;
    // Điểm cốt lõi §2#21: token không bypass capability của chủ token.
    const ok = await this.evaluator.hasCapability(row.userId, def.capability, contextId);
    if (!ok) throw new ForbiddenException({ message: `Token owner lacks capability ${def.capability}`, code: 'webservice.capability_denied' });
    await this.repo.updateToken(row.id, { lastAccess: new Date() });
    return def.handler(row.userId, args);
  }
}
