/**
 * Bề mặt HTTP gói YCCĐ của kho ngân hàng hệ thống (issue #585):
 * - `POST /system-bank/outcome-packages` — phát hành một gói YCCĐ
 *   phía platform (quản trị platform): chụp cây chương trình hiện
 *   hành thành bản phát hành có checksum.
 * - `GET /system-bank/outcome-packages` — liệt kê các gói đã phát hành.
 * - `GET /system-bank/outcome-packages/:version` — đọc một gói kèm items.
 * - `POST /system-bank/outcome-packages/:version/install` — cài gói
 *   vào kho trung tâm (trung tâm chủ động nhận gói mới; gác quyền
 *   `curriculum:manage` tại context từng môn gói chạm tới).
 *
 * Controller chỉ là lớp vận chuyển mỏng; gác quyền và luật nghiệp vụ
 * nằm ở service. Cập nhật gói không sửa ngược các gắn chuẩn đã có
 * (gắn chuẩn trỏ theo id YCCĐ); ánh xạ mã cũ→mã mới trong gói chỉ là
 * thông tin tham chiếu.
 */
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { SystemBankService } from './system-bank.service';
import {
  createSystemOutcomePackageSchema,
  type CreateSystemOutcomePackageDto,
} from './dto/system-bank.dto';

@Controller({ path: 'system-bank/outcome-packages', version: '1' })
export class SystemBankPackagesController {
  constructor(private readonly bank: SystemBankService) {}

  @Post()
  async createPackage(
    @Body({ schema: createSystemOutcomePackageSchema }) dto: CreateSystemOutcomePackageDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.createOutcomePackage(actor.id, dto);
  }

  @Get()
  async listPackages() {
    return this.bank.listOutcomePackages();
  }

  @Get(':version')
  async getPackage(@Param('version') version: string) {
    return this.bank.getOutcomePackage(version);
  }

  @Post(':version/install')
  async installPackage(
    @Param('version') version: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.installOutcomePackage(actor.id, version);
  }
}
