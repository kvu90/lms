import { Injectable } from '@nestjs/common';
import {
  CohortMaterializationSurface,
  type SharedOutboxEventInput,
  type SharedOutboxPort,
} from '@lms/enrol';
import { sql, type CentreDB, type CentreTx } from '@lms/db';
import { tenantAls } from './db/tenant-als';
import { SpaceDatabaseService } from './db/routing/space-database.service';

/**
 * Cổng ghi outbox của tiến trình worker cho bề mặt vật chất hoá
 * cohort dùng chung (`@lms/enrol`) — bản sao đúng hợp đồng cổng mà
 * dịch vụ outbox của API vẫn giữ, viết lại cho hạ tầng của worker:
 *
 * - `enqueue` ghi dòng sự kiện trong transaction Kysely được truyền
 *   vào, để dòng sự kiện commit hoặc rollback cùng thay đổi nghiệp
 *   vụ của lõi (transaction rollback thì không tồn tại dòng sự kiện
 *   nào).
 * - Tenant hiệu lực mặc định lấy từ ngữ cảnh ALS của luồng phát sinh
 *   khi nơi gọi không chỉ định tường minh; tenant cũng được gương
 *   vào payload để các consumer chạy ở ngữ cảnh platform biết sự
 *   kiện thuộc tenant nào. Processor đồng bộ cohort chạy trong ngữ
 *   cảnh platform nên các dòng do bề mặt phát ở đây mang
 *   `tenantId` null — đúng hành vi của consumer polling phía API
 *   trước đây (nhịp quét của nó cũng không mang ngữ cảnh tenant).
 * - `enqueueStandalone` ghi trong một transaction Kysely ngắn riêng,
 *   dùng cho đường đình chỉ do đồng bộ hệ thống của bề mặt (phát
 *   `user_enrolment_suspended` sau khi đã cập nhật trạng thái).
 */
class WorkerOutboxPort implements SharedOutboxPort {
  constructor(private readonly spaceDb: SpaceDatabaseService) {}

  async enqueue(tx: CentreTx, input: SharedOutboxEventInput): Promise<void> {
    const tenantId = input.tenantId ?? tenantAls.getStore()?.tenantId ?? null;
    const payload = tenantId && input.payload['tenantId'] === undefined
      ? { ...input.payload, tenantId }
      : input.payload;
    await tx
      .insertInto('outbox_events')
      .values({
        aggregate: input.aggregate,
        type: input.type,
        // Cột `payload` jsonb đi qua serialize tường minh kèm
        // `::jsonb` theo khuôn ghi jsonb của `@lms/db`: driver `pg`
        // tự stringify object thường nhưng hiểu MẢNG cấp cao nhất
        // là mảng PostgreSQL.
        payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify(payload)}::jsonb`,
        tenant_id: tenantId,
      })
      .execute();
  }

  async enqueueStandalone(input: SharedOutboxEventInput): Promise<void> {
    await this.spaceDb.routedKysely.transaction().execute((trx) => this.enqueue(trx, input));
  }
}

/**
 * Host phía worker của bề mặt vật chất hoá cohort dùng chung
 * (`@lms/enrol`) — tầng nối duy nhất giữa consumer hàng đợi đồng bộ
 * cohort ở worker và bề mặt đó (issue con #528 của #519, đợt tách
 * #491).
 *
 * Vai trò: dựng bề mặt một lần bằng tay cầm Kysely đã định tuyến
 * của worker, cổng outbox của worker và cổng ngữ cảnh platform của
 * worker (`tenantAls` của worker — mỗi app giữ bản sao hạ tầng riêng
 * theo tiền lệ repo, package không được giữ bản sao thứ ba), rồi uỷ
 * hai điểm vào vật chất hoá theo sự kiện thành viên cohort cho bề
 * mặt. Mọi luật nghiệp vụ (điều kiện thành viên, chốt tách vai, chế
 * độ rời, phát tiếp `user_enrolment_suspended`) sống trong bề mặt
 * dùng chung — service này không định nghĩa lại bất kỳ kiểm nào,
 * không giữ trạng thái xử lý nào của riêng nó.
 */
@Injectable()
export class CohortSyncService {
  private readonly materialization: CohortMaterializationSurface;

  constructor(spaceDb: SpaceDatabaseService) {
    this.materialization = new CohortMaterializationSurface({
      db: spaceDb.routedKysely,
      outbox: new WorkerOutboxPort(spaceDb),
      // Phạm vi platform của bề mặt: giữ nguyên `spaceSlug` của
      // ngữ cảnh đang chạy (issue #582) — phạm vi này chỉ đổi tầm
      // nhìn RLS sang đường platform, không đổi kho đích; một job
      // của trung tâm ở kho riêng chạy trong phiên theo trung tâm
      // mà phạm vi platform dựng store mới không mang slug thì
      // handle định tuyến rơi về kho chung, ghi sai kho.
      runInPlatformScope: (fn) =>
        tenantAls.run({ platform: true, spaceSlug: tenantAls.getStore()?.spaceSlug }, fn),
    });
  }

  /**
   * Vật chất hoá "thành viên mới vào cohort": ghi danh người dùng
   * vào mọi khoá học có instance cohort tương ứng đang bật, qua
   * bề mặt dùng chung (guard theo trạng thái hiện tại của
   * `cohort_members`, bỏ qua riêng lẻ thành viên vi phạm chốt tách
   * vai).
   *
   * @param payload Định danh cohort và người dùng của sự kiện thành viên.
   */
  async materializeMemberAdded(payload: { cohortId: string; userId: string }): Promise<void> {
    await this.materialization.materializeCohortMemberAdded(payload);
  }

  /**
   * Vật chất hoá "thành viên rời cohort": rút hoặc đình chỉ ghi danh
   * cohort tương ứng theo chế độ rời của từng instance, qua bề mặt
   * dùng chung (guard theo trạng thái hiện tại của `cohort_members`;
   * chế độ đình chỉ phát tiếp `user_enrolment_suspended` với lý do
   * `cohort_removed`).
   *
   * @param payload Định danh cohort và người dùng của sự kiện thành viên.
   */
  async materializeMemberRemoved(payload: { cohortId: string; userId: string }): Promise<void> {
    await this.materialization.materializeCohortMemberRemoved(payload);
  }
}
