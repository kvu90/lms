import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { SiteConfigService } from '../site-config/site-config.service';
import { tenantAls } from '../tenants/tenant-als';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';

/**
 * Idempotent bootstrap seed: system context, capability registry, standard
 * Moodle core roles + archetype defaults, the special guest account, and the
 * initial site administrator (from env) with the manager role + siteadmins.
 */
@Injectable()
/**
 * Gieo dữ liệu nền khi ứng dụng khởi động: context hệ thống, capability, role archetype, tài khoản guest và admin site.
 * Idempotent — chạy lại không tạo trùng; thông tin admin lấy từ biến môi trường ADMIN_*.
 *
 * TENANT-0 (#168): bootstrap cũng gieo tenant-zero (Trang chính) + tenant
 * trường mặc định, gắn membership cho admin khởi tạo ở cả hai, và — khi
 * PLATFORM_ADMIN_* được đặt — tạo tài khoản VẬN HÀNH PLATFORM riêng (chỉ
 * thuộc tenant-zero, là siteadmin) tách bạch khỏi admin mẫu của tenant-1.
 */
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);
  constructor(
    private readonly roles: RolesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly users: UsersService,
    private readonly config: ConfigService,
    private readonly tenants: TenantsService,
    private readonly siteConfig: SiteConfigService,
  ) {}
  /**
   * Điểm vào bootstrap: gieo context hệ thống, role mặc định, capability, guest và admin.
   *
   * HOTFIX #196 (sự cố triển khai TENANT-1): toàn bộ thân seed chạy trong
   * ngữ cảnh PLATFORM tường minh. Seed đụng các bảng có RLS fail-closed
   * (tenants, tenant_memberships, plugin_config/tenant_config qua
   * site-config) — chạy ngoài ngữ cảnh như trước TENANT-1 thì
   * `ensurePlatformTenant` bị WITH CHECK chặn (42501) và app không boot
   * được trên DB trống. Đây là cùng khuôn với review-seed và mọi
   * consumer/processor nền: seed là đường vận hành platform, không phải
   * bề mặt nghiệp vụ của một tenant.
   */
  async onApplicationBootstrap(): Promise<void> {
    await tenantAls.run({ platform: true }, () => this.seedInPlatformContext());
  }

  private async seedInPlatformContext(): Promise<void> {
    await this.roles.seedDefaults();
    await this.users.ensureGuestUser();
    const zero = await this.tenants.ensurePlatformTenant();
    const fullname = (await this.siteConfig.getValue<string>('core', 'fullname')) ?? 'LMS';
    const school = await this.tenants.ensureDefaultSchoolTenant(fullname);
    const admins = (await this.currentSiteAdmins());
    let admin: UserRow | undefined;
    if (admins.length === 0) {
      const username = this.config.get<string>('ADMIN_USERNAME') ?? 'admin';
      admin = await this.users.getByUsername(username);
      if (!admin) {
        admin = await this.users.createUser({
          username,
          email: this.config.get<string>('ADMIN_EMAIL') ?? 'admin@localhost',
          password: this.config.get<string>('ADMIN_PASSWORD') ?? 'Admin123!',
          firstName: 'Site', lastName: 'Administrator',
        });
      }
      const system = await this.contexts.ensureSystemContext();
      const manager = await this.roles.getRoleByShortname('manager');
      if (manager) await this.roles.assignRole(admin.id, manager.id, system.id);
      await this.evaluator.setSiteAdmins([admin.id]);
      this.logger.log(`Seeded initial site administrator "${username}" (id ${admin.id})`);
    } else {
      admin = await this.users.getByIdOrUndefined(admins[0]!);
    }
    if (admin) {
      // Admin khởi tạo là thành viên của cả tenant-zero lẫn tenant trường
      // mặc định, và là tenant admin (manager tại context tenant) của cả
      // hai — câu chuyện demo của review-seed.
      await this.tenants.ensureActiveMembership(zero.id, admin.id);
      await this.tenants.ensureActiveMembership(school.id, admin.id);
      const manager = await this.roles.getRoleByShortname('manager');
      if (manager) {
        await this.assignRoleIfMissing(admin.id, manager.id, (await this.contexts.ensureTenantContext(zero.id)).id);
        await this.assignRoleIfMissing(admin.id, manager.id, (await this.contexts.ensureTenantContext(school.id)).id);
      }
    }
    await this.ensurePlatformOperator(zero.id);
  }

  /** Gán vai nếu chưa có dòng gán tương ứng (assignRole luôn chèn dòng mới nên seed phải tự canh trùng). */
  private async assignRoleIfMissing(userId: string, roleId: string, contextId: string): Promise<void> {
    const existing = (await this.roles.listAssignments({ userId, contextId })) as { roleId: string }[];
    if (existing.some((a) => a.roleId === roleId)) return;
    await this.roles.assignRole(userId, roleId, contextId);
  }

  /**
   * Tài khoản vận hành platform RIÊNG từ biến môi trường PLATFORM_ADMIN_*:
   * chỉ được tạo khi biến được đặt; là siteadmin (quyền vận hành tầng
   * platform) và chỉ thuộc tenant-zero — KHÔNG phải admin mẫu của
   * tenant-1, giữ hai vai tách bạch như đặc tả #168 mục 6.3 yêu cầu.
   */
  private async ensurePlatformOperator(platformTenantId: string): Promise<void> {
    const username = this.config.get<string>('PLATFORM_ADMIN_USERNAME');
    if (!username) return;
    const bootstrapUsername = this.config.get<string>('ADMIN_USERNAME') ?? 'admin';
    if (username === bootstrapUsername) return;
    let operator = await this.users.getByUsername(username);
    if (!operator) {
      operator = await this.users.createUser({
        username,
        email: this.config.get<string>('PLATFORM_ADMIN_EMAIL') ?? `${username}@localhost`,
        password: this.config.get<string>('PLATFORM_ADMIN_PASSWORD') ?? 'Platform123!',
        firstName: 'Platform', lastName: 'Operator',
      });
      this.logger.log(`Seeded platform operator "${username}" (id ${operator.id})`);
    }
    const admins = await this.currentSiteAdmins();
    if (!admins.includes(operator.id)) {
      await this.evaluator.setSiteAdmins([...admins, operator.id]);
    }
    await this.tenants.ensureActiveMembership(platformTenantId, operator.id);
  }

  private async currentSiteAdmins(): Promise<string[]> {
    return this.evaluator.listSiteAdmins();
  }
}
