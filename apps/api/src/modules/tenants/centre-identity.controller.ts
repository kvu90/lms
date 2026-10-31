import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { CentreIdentityService } from './centre-identity.service';
import { activateCentreInviteSchema, updateCentreIdentitySchema, type ActivateCentreInviteDto, type UpdateCentreIdentityDto } from './dto/centres.dto';
import { SkipSpaceContext } from './skip-space-context.decorator';

@ApiTags('centres')
@Controller({ path: 'centres', version: '1' })
/**
 * Bề mặt trung tâm đã cấp phát riêng (issue #583): nhận diện công
 * khai của trung tâm và kích hoạt lời mời quản trị đầu tiên.
 *
 * Hai route công khai mang `@SkipSpaceContext` vì chúng phải chạy
 * được trước khi phiên thuộc về trung tâm (trang đăng nhập đọc
 * tên/logo trước khi đăng nhập; lời mời kích hoạt trước khi tài
 * khoản có phiên): service tự gắn trung tâm trước mọi truy vấn nên
 * việc bỏ qua guard không phải là bỏ qua gắn trung tâm. Route PATCH
 * là đường nghiệp vụ có xác thực — chỉ quản trị của chính trung tâm
 * đó mới sửa được nhận diện của nó.
 */
export class CentreIdentityController {
  constructor(private readonly centres: CentreIdentityService) {}

  @Public()
  @SkipSpaceContext()
  @Get(':slug/identity')
  /** GET /centres/:slug/identity — nhận diện công khai của trung tâm (tên hiển thị, logo, màu thương hiệu). */
  async getIdentity(@Param('slug') slug: string, @Headers('host') host: string | undefined) {
    this.centres.assertRequestAddress(slug, host);
    return this.centres.getIdentity(slug);
  }

  @Patch(':slug/identity')
  /** PATCH /centres/:slug/identity — sửa nhận diện của trung tâm (chỉ quản trị của trung tâm đó). */
  async updateIdentity(
    @Param('slug') slug: string,
    @Headers('host') host: string | undefined,
    @Body({ schema: updateCentreIdentitySchema }) dto: UpdateCentreIdentityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    this.centres.assertRequestAddress(slug, host);
    return this.centres.updateIdentity(slug, actor.id, dto);
  }

  @Public()
  @SkipSpaceContext()
  @Post('activate-invite')
  /** POST /centres/activate-invite — kích hoạt tài khoản quản trị đầu tiên bằng lời mời dùng một lần. */
  async activateInvite(@Body({ schema: activateCentreInviteSchema }) dto: ActivateCentreInviteDto, @Headers('host') host: string | undefined) {
    this.centres.assertRequestAddress(dto.slug, host);
    return this.centres.activateInvite(dto);
  }
}
