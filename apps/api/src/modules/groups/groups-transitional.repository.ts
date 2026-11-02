import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../db/database';
import { cohortMembers } from '../../db/schema';

/**
 * Repository CHUYỂN TIẾP phía Drizzle của đường gỡ thành viên
 * cohort trong transaction của bên gọi — điểm nối C-8/C của
 * chiến dịch chuyển Kysely (xem `CORRECTIONS.md` của chiến dịch,
 * mục C-8).
 *
 * Toàn bộ bề mặt dữ liệu của cụm groups đã chuyển sang repository
 * Kysely ở `@lms/db/repositories/groups`. Riêng đường
 * `ClassesService.suspendPaidClassMember` →
 * `GroupsService.removeCohortMemberInternal` giữ nguyên chữ ký
 * transaction Drizzle để bảo toàn bất biến nguyên tử DL-10
 * (issue #490): `PaymentsService` truyền transaction settle hoàn
 * tiền của nó xuống, và việc gỡ thành viên khỏi backing cohort
 * phải nằm trong ĐÚNG transaction đó — settle rollback thì việc
 * gỡ cũng rollback.
 *
 * File này CHỈ chứa đúng lệnh ghi đường vào đó thực hiện (xoá
 * một dòng `cohort_members` trong transaction được truyền vào,
 * trả về có xoá được dòng hay không) — không đọc, không logic
 * thêm. Mọi đường gọi khác của `removeCohortMemberInternal` đi
 * qua repository Kysely. Chủ đóng: D4 (#656) — khi chuyển
 * payments sang Kysely, PR đó lật lời gọi sang điểm vào Kysely
 * và XOÁ file này; issue #663 đối chiếu không còn sót.
 */
@Injectable()
export class GroupsTransitionalRepository {
  /** Xoá một dòng thành viên cohort trong transaction Drizzle của bên gọi (điểm nối C-8/C); trả `true` khi có dòng bị xoá. */
  async removeCohortMember(cohortId: string, userId: string, tx: DbTx): Promise<boolean> {
    const deleted = await tx
      .delete(cohortMembers)
      .where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)))
      .returning();
    return deleted.length > 0;
  }
}
