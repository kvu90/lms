import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { SystemBankService } from './system-bank.service';
import {
  createSystemBankQuestionSchema,
  createSystemBankVersionSchema,
  withdrawSystemBankQuestionSchema,
  type CreateSystemBankQuestionDto,
  type CreateSystemBankVersionDto,
  type WithdrawSystemBankQuestionDto,
} from './dto/system-bank.dto';

/**
 * Bề mặt HTTP của kho ngân hàng hệ thống (issue #585) — tiền tố riêng
 * `system-bank`, tách khỏi mọi tiền tố nghiệp vụ:
 * - `POST /system-bank/questions` — phát hành câu mới kèm phiên bản đầu tiên (quản trị platform).
 * - `POST /system-bank/questions/:id/versions` — phát hành phiên bản mới cho câu đã có (quản trị platform).
 * - `POST /system-bank/questions/:id/withdraw` — rút câu: ngừng khám phá + ngừng nhập mới, ghi sự kiện (quản trị platform).
 * - `GET /system-bank/questions/:id` — đọc một câu (mọi trạng thái; cổng người xem `question:useall`).
 * - `GET /system-bank/questions/:id/versions` — liệt kê mọi phiên bản của câu (cùng cổng người xem).
 * - `GET /system-bank/questions/:id/versions/:version` — đọc một phiên bản kèm checksum (cùng cổng người xem).
 *
 * Khám phá có lọc (theo vị trí chương trình/YCCĐ/dạng/mức độ), nhập
 * bản chụp, ghi nhận sự kiện rút câu ở trung tâm và gói YCCĐ là các
 * route của các lát tiếp theo trong cùng issue, chung tiền tố này.
 * Controller chỉ là lớp vận chuyển mỏng; gác quyền và luật nghiệp vụ
 * nằm ở service.
 */
@Controller({ path: 'system-bank/questions', version: '1' })
export class SystemBankController {
  constructor(private readonly bank: SystemBankService) {}

  @Post()
  async publish(
    @Body({ schema: createSystemBankQuestionSchema }) dto: CreateSystemBankQuestionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.publishQuestion(actor.id, dto);
  }

  @Post(':id/versions')
  async publishVersion(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: createSystemBankVersionSchema }) dto: CreateSystemBankVersionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.publishVersion(actor.id, id, dto);
  }

  @Post(':id/withdraw')
  async withdraw(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Body({ schema: withdrawSystemBankQuestionSchema }) dto: WithdrawSystemBankQuestionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.withdrawQuestion(actor.id, id, dto);
  }

  @Get(':id')
  async getQuestion(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.getQuestion(actor.id, id);
  }

  @Get(':id/versions')
  async listVersions(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bank.listVersions(actor.id, id);
  }

  @Get(':id/versions/:version')
  async getVersion(
    @Param('id', { schema: uuidIdSchema }) id: string,
    @Param('version') version: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const versionNumber = Number(version);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw new BadRequestException({ message: `Invalid version number: ${version}`, code: 'system_bank.bad_version' });
    }
    return this.bank.getVersion(actor.id, id, versionNumber);
  }
}
