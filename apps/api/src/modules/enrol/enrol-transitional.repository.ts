import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DbTx } from '../../db/database';
import { userEnrolments } from '../../db/schema';

/**
 * Repository CHUYỂN TIẾP phía Drizzle của điểm vào `setSuspended`
 * — điểm nối C-8/C của chiến dịch chuyển Kysely (xem
 * `CORRECTIONS.md` của chiến dịch, mục C-8).
 *
 * Toàn bộ bề mặt dữ liệu của cụm enrol đã chuyển sang repository
 * Kysely ở `@lms/db/repositories/enrol`. Riêng đường vào từ
 * payments giữ nguyên chữ ký transaction Drizzle để bảo toàn bất
 * biến nguyên tử DL-10 (issue #490): `PaymentsService` truyền
 * transaction settle của nó vào `EnrolService.setSuspended`, và
 * việc đình chỉ/kích hoạt lại ghi danh phải nằm trong ĐÚNG
 * transaction đó — settle rollback thì đình chỉ cũng rollback.
 *
 * File này CHỈ chứa đúng lệnh ghi đường vào đó thực hiện (cập
 * nhật trạng thái + người sửa của một dòng `user_enrolments`
 * trong transaction được truyền vào) — không đọc, không logic
 * thêm. Mọi đường gọi khác của `setSuspended` (đường tự mở
 * transaction) đi qua repository Kysely. Chủ đóng: D4 (#656) —
 * khi chuyển payments sang Kysely, PR đó lật lời gọi sang điểm
 * vào Kysely của `setSuspended` và XOÁ file này; issue #663 đối
 * chiếu không còn sót.
 */
@Injectable()
export class EnrolTransitionalRepository {
  /** Cập nhật một dòng ghi danh trong transaction Drizzle của bên gọi (điểm nối C-8/C). */
  async updateUserEnrolment(id: string, v: Partial<typeof userEnrolments.$inferInsert>, tx: DbTx): Promise<void> {
    await tx.update(userEnrolments).set({ ...v, updatedAt: new Date() }).where(eq(userEnrolments.id, id));
  }
}
