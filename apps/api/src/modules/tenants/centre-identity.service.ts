import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { hashCentreInviteToken } from './centre-provision';
import { SpaceRoutingError } from '../../db/routing/space-connection-resolver';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import type { ActivateCentreInviteDto, UpdateCentreIdentityDto } from './dto/centres.dto';
import { UsersService } from '../users/users.service';
import { CentreIdentityRepository } from './centre-identity.repository';
import { extractSpaceSlugFromHost } from './space-resolution';
import { tenantAls } from './tenant-als';
import { TenantsRepository } from './tenants.repository';

/**
 * Nhận diện riêng của trung tâm + kích hoạt lời mời quản trị đầu
 * tiên (issue #583, chương trình tenant #579).
 *
 * Luồng gắn trung tâm của mọi phương thức ở đây (thay cho guard,
 * vì các route này mang `@SkipSpaceContext`):
 * 1. Phân giải slug qua khung định tuyến (sổ đăng ký control plane
 *    là nguồn sự thật duy nhất). Slug chưa đăng ký → 404; tầng chưa
 *    cấu hình → 503 — fail-closed, không bao giờ phục vụ bằng kho
 *    chung khi người gọi đã chỉ đích danh một trung tâm. NGOẠI LỆ:
 *    đọc nhận diện (GET) bỏ qua bước này khi trung tâm đã chuẩn bị
 *    trong tiến trình — xem `getIdentity`.
 * 2. Chuẩn bị kho đích (`getDatabaseForSpace`) TRƯỚC mọi truy vấn —
 *    kho chung cho trung tâm ở kho chung, kho riêng cho trung tâm ở
 *    kho riêng.
 * 3. Chạy truy vấn trong ngữ cảnh ALS `{ platform: true, spaceSlug }`:
 *    handle được định tuyến theo slug đã chuẩn bị chọn đúng kho, cờ
 *    platform cho phép đọc xuyên tenant trong chính kho đó (đọc
 *    nhận diện công khai, đọc lời mời, kiểm tra danh sách quản trị
 *    của kho). Đây là đường vận hành/đọc công khai, không phải
 *    đường nghiệp vụ của một phiên thuộc tenant — vì vậy không gắn
 *    `tenantId` của phiên vào đây.
 *
 * Đọc nhận diện (GET) KHÔNG chặn theo trạng thái sổ đăng ký: tên và
 * logo là thông tin công khai của trang đăng nhập, không phải
 * traffic nghiệp vụ — trung tâm bị đình chỉ vẫn cần hiện tên của
 * nó. Mọi đường ghi (PATCH, kích hoạt) đều chặn khi trung tâm chưa
 * `active`, đúng luật của guard cho traffic nghiệp vụ.
 */
@Injectable()
export class CentreIdentityService {
  constructor(
    private readonly spaceDb: SpaceDatabaseService,
    private readonly tenants: TenantsRepository,
    private readonly centreRepo: CentreIdentityRepository,
    private readonly users: UsersService,
  ) {}

  /**
   * Ràng buộc địa chỉ: khi request tới ở địa chỉ của một trung tâm
   * (tên miền con), slug trong đường dẫn/thân phải đúng trung tâm
   * đó — tránh kích hoạt hay đọc nhận diện nhầm trung tâm. Địa chỉ
   * platform (không mang slug) thì không ràng buộc.
   */
  assertRequestAddress(slug: string, hostHeader: string | string[] | undefined) {
    const addressSlug = extractSpaceSlugFromHost(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);
    if (addressSlug && addressSlug !== slug) {
      throw new BadRequestException({ message: 'Request address does not match the requested centre', code: 'centre.address_mismatch' });
    }
  }

  /**
   * Nhận diện công khai của trung tâm (chưa có dòng thì lấy tên tenant làm mặc định).
   * Đường đọc này KHÔNG chạm control plane khi trung tâm đã chuẩn bị
   * trong tiến trình (lần đọc đầu đã phân giải + chuẩn bị kho): handle
   * đã-chuẩn-bị đủ để đọc kho của trung tâm — đúng tiêu chí nghiệm
   * thu "tắt control plane sau khi đã định tuyến, bề mặt vẫn hiển thị
   * đúng nhận diện". Khi chưa chuẩn bị thì vẫn phải phân giải + chuẩn
   * bị trước (đọc thẳng qua handle định tuyến khi chưa chuẩn bị sẽ
   * rơi về kho chung — sai kho).
   */
  async getIdentity(slug: string) {
    if (!this.spaceDb.isSpacePrepared(slug)) {
      await this.bindCentreSpace(slug, false);
    }
    return this.runInCentreSpace(slug, async () => {
      const tenant = await this.tenants.getTenantBySlug(slug);
      if (!tenant) throw new NotFoundException({ message: 'Centre not found', code: 'centre.not_found' });
      const identity = await this.centreRepo.getIdentity(tenant.id);
      return {
        tenantId: tenant.id,
        displayName: identity?.displayName ?? tenant.name,
        logoPath: identity?.logoPath ?? null,
        brandColor: identity?.brandColor ?? null,
      };
    });
  }

  /** Sửa nhận diện — chỉ quản trị của chính trung tâm đó (đọc từ kho của trung tâm). */
  async updateIdentity(slug: string, actorId: string, dto: UpdateCentreIdentityDto) {
    await this.bindCentreSpace(slug, true);
    return this.runInCentreSpace(slug, async () => {
      const tenant = await this.tenants.getTenantBySlug(slug);
      if (!tenant) throw new NotFoundException({ message: 'Centre not found', code: 'centre.not_found' });
      const admins = await this.centreRepo.listSiteAdmins();
      if (!admins.includes(actorId)) {
        throw new ForbiddenException({ message: 'Only an admin of this centre may change its identity', code: 'centre.not_admin' });
      }
      const row = await this.centreRepo.upsertIdentity(tenant.id, dto);
      return { tenantId: tenant.id, displayName: row.displayName, logoPath: row.logoPath, brandColor: row.brandColor };
    });
  }

  /**
   * Kích hoạt tài khoản quản trị đầu tiên bằng lời mời.
   * Thứ tự đốt-trước-đặt-mật-khẩu-sau là cố ý (fail-closed cho
   * token): nếu đặt mật khẩu thất bại (ví dụ mật khẩu yếu bị chính
   * sách chặn), lời mời đã cháy và quản trị phải phát hành lại bằng
   * CLI — ngược lại, mật khẩu đặt xong mà lời mời còn hiệu lực sẽ
   * để lại một token dùng được sau khi tài khoản đã có mật khẩu.
   */
  async activateInvite(dto: ActivateCentreInviteDto) {
    await this.bindCentreSpace(dto.slug, true);
    const invite = await this.runInCentreSpace(dto.slug, async () => {
      const tenant = await this.tenants.getTenantBySlug(dto.slug);
      if (!tenant) throw new NotFoundException({ message: 'Centre not found', code: 'centre.not_found' });
      const found = await this.centreRepo.findInviteByTokenHash(hashCentreInviteToken(dto.token));
      if (!found) throw new NotFoundException({ message: 'Invite not found', code: 'centre.invite_not_found' });
      if (found.expiresAt <= new Date()) throw new GoneException({ message: 'Invite has expired', code: 'centre.invite_expired' });
      if (found.usedAt) throw new ConflictException({ message: 'Invite has already been used', code: 'centre.invite_consumed' });
      if (found.revokedAt) throw new ConflictException({ message: 'Invite has been revoked', code: 'centre.invite_revoked' });
      const marked = await this.centreRepo.markInviteUsed(found.id);
      if (!marked) throw new ConflictException({ message: 'Invite has already been used', code: 'centre.invite_consumed' });
      return found;
    });
    // Đặt mật khẩu trong cùng kho đã gắn (handle định tuyến theo
    // slug): updateUser không truyền actor nên bỏ qua chốt chặn tự
    // đặt mật khẩu — đây là hành động hệ thống theo lời mời, không
    // phải người dùng tự đổi mật khẩu của mình.
    await this.runInCentreSpace(dto.slug, async () => {
      await this.users.updateUser(invite.userId, { password: dto.password });
    });
    return { activated: true as const, userId: invite.userId };
  }

  /**
   * Gắn trung tâm: phân giải + (tuỳ chọn) chặn khi chưa `active` +
   * chuẩn bị kho đích. Lỗi định tuyến được dịch sang mã lỗi API
   * (404/503) thay vì để lỗi nội bộ của khung rò ra ngoài.
   */
  private async bindCentreSpace(slug: string, requireActive: boolean): Promise<void> {
    let target;
    try {
      target = await this.spaceDb.resolveTarget(slug);
    } catch (err) {
      throw this.mapRoutingError(err);
    }
    if (requireActive && target.status !== 'active') {
      throw new ForbiddenException({ message: 'Centre is not active', code: 'space.not_active' });
    }
    try {
      await this.spaceDb.getDatabaseForSpace(slug);
    } catch (err) {
      throw this.mapRoutingError(err);
    }
  }

  private runInCentreSpace<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    return tenantAls.run({ platform: true, spaceSlug: slug }, async () => fn());
  }

  private mapRoutingError(err: unknown): Error {
    if (err instanceof SpaceRoutingError) {
      if (err.code === 'space_routing.space_not_found') {
        return new NotFoundException({ message: 'Centre not found', code: 'centre.not_found' });
      }
      if (err.code === 'space_routing.not_configured') {
        return new ServiceUnavailableException({ message: 'Control plane is not configured', code: 'control_plane.not_configured' });
      }
    }
    return err instanceof Error ? err : new Error('Unknown routing error');
  }
}
