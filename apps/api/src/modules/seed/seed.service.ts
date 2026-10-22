import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { UsersService } from '../users/users.service';

/**
 * Idempotent bootstrap seed: system context, capability registry, standard
 * Moodle core roles + archetype defaults, the special guest account, and the
 * initial site administrator (from env) with the manager role + siteadmins.
 */
@Injectable()
/**
 * Gieo dữ liệu nền khi ứng dụng khởi động: context hệ thống, capability, role archetype, tài khoản guest và admin site.
 * Idempotent — chạy lại không tạo trùng; thông tin admin lấy từ biến môi trường ADMIN_*.
 */
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);
  constructor(
    private readonly roles: RolesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}
  /**
   * Điểm vào bootstrap: gieo context hệ thống, role mặc định, capability, guest và admin.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.roles.seedDefaults();
    await this.users.ensureGuestUser();
    const admins = (await this.currentSiteAdmins());
    if (admins.length === 0) {
      const username = this.config.get<string>('ADMIN_USERNAME') ?? 'admin';
      let admin = await this.users.getByUsername(username);
      if (!admin) {
        admin = await this.users.createUser({
          username,
          email: this.config.get<string>('ADMIN_EMAIL') ?? 'admin@localhost',
          password: this.config.get<string>('ADMIN_PASSWORD') ?? 'Admin123!',
          firstname: 'Site', lastname: 'Administrator',
        });
      }
      const system = await this.contexts.ensureSystemContext();
      const manager = await this.roles.getRoleByShortname('manager');
      if (manager) await this.roles.assignRole(admin.id, manager.id, system.id);
      await this.evaluator.setSiteAdmins([admin.id]);
      this.logger.log(`Seeded initial site administrator "${username}" (id ${admin.id})`);
    }
  }
  private async currentSiteAdmins(): Promise<number[]> {
    return this.evaluator.listSiteAdmins();
  }
}
