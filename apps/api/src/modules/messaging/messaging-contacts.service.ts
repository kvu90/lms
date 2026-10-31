import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { MessagingRepository } from './messaging.repository';
import { MessagingRealtimeService } from './messaging-realtime.service';
import { MessagingNotificationsService } from './messaging-notifications.service';

/** Tóm tắt hiển thị của một user trong các response của messaging (hợp đồng ở @lms/contracts). */
export interface PersonSummaryView {
  userId: string;
  displayName: string;
  username: string;
}

/** Trạng thái quan hệ của một người so với người đang tìm (hợp đồng ở @lms/contracts). */
export type ContactRelationship = 'contact' | 'pending_incoming' | 'pending_outgoing' | 'blocked' | 'none';

/** Tên hiển thị của một user: "firstName lastName" đã cắt khoảng trắng; cả hai trống thì lùi về username. */
export function displayNameOf(user: { firstName: string; lastName: string; username: string }): string {
  const name = `${user.firstName} ${user.lastName}`.trim();
  return name || user.username;
}

/**
 * LIÊN HỆ + CHẶN của MessagingModule (cụm ca sử dụng "liên hệ/chặn").
 *
 * Luồng nghiệp vụ: quan hệ liên hệ là quan hệ CÓ DUYỆT (thay danh bạ
 * một chiều cũ như Moodle): gửi yêu cầu → phía kia chấp nhận thì quan
 * hệ mới tồn tại ở cả hai chiều; từ chối thì yêu cầu biến mất, quan
 * hệ không hình thành; gửi yêu cầu cho người đã gửi yêu cầu cho mình
 * = chấp nhận ngầm. Cổng liên lạc (đã chốt lại 24/10/2026 trên issue
 * #33): nhắn riêng 1-1 CHỈ giữa liên hệ đã được duyệt — `assertCanContact`
 * là cổng đó, cụm hội thoại và cụm tin nhắn gọi nó trước khi mở/gửi;
 * ngoại lệ duy nhất là quan hệ giáo viên–học viên cùng khoá/lớp còn
 * hiệu lực. Chặn là quan hệ một chiều cứng hơn liên hệ: người bị chặn
 * không gửi được tin và không thấy người chặn; huỷ chặn khôi phục tầm
 * nhìn hội thoại cũ. `profilesFor`/`displayNameOf` là tiện ích hiển
 * thị người dùng dùng chung cho các cụm khác (roster, danh sách hội
 * thoại). Method `assertCanContact` để public trong nội bộ module cho
 * các service cụm gọi — không phải bề mặt API của MessagingModule.
 *
 * Cách lắp ráp (issue #295): service này là một CỤM của MessagingModule,
 * tách từ MessagingService cũ theo cụm ca sử dụng — tách cấu trúc thuần,
 * không đổi hành vi. MessagingService nay là facade giữ nguyên bề mặt
 * công khai và chữ ký constructor, tự lắp ráp các service cụm trong
 * constructor của nó (các test đơn vị hiện hữu khởi tạo trực tiếp
 * `new MessagingService(...)` với đúng các phụ thuộc hạ tầng cũ nên
 * facade là điểm lắp ráp để giữ nguyên hợp đồng khởi tạo đó); các
 * service cụm không đăng ký provider riêng trong module và module
 * wiring giữ nguyên như trước khi tách.
 */
export class MessagingContactsService {
  constructor(
    private readonly repo: MessagingRepository,
    private readonly users: UsersService,
    private readonly realtime: MessagingRealtimeService,
    private readonly notifications: MessagingNotificationsService,
  ) {}

  // --- contacts: luồng yêu cầu – chấp nhận (Lớp B) ---------------------------
  // Thay danh bạ MỘT CHIỀU cũ bằng quan hệ có duyệt như Moodle: gửi yêu
  // cầu → phía kia chấp nhận thì quan hệ mới tồn tại (ở cả hai chiều)
  // và mới mở cổng liên lạc; từ chối thì yêu cầu biến mất, quan hệ
  // không hình thành. Gửi yêu cầu cho người ĐÃ gửi yêu cầu cho mình =
  // chấp nhận ngầm (hai phía cùng muốn kết nối thì không cần thêm một
  // lượt duyệt nữa).

  /**
   * Gửi yêu cầu kết bạn tới một user. Đã là liên hệ thì trả trạng thái
   * accepted (idempotent); đã có yêu cầu chiều ngược đang chờ thì chấp
   * nhận luôn yêu cầu đó. Người bị phía kia chặn (hoặc đã chặn phía
   * kia) không gửi được yêu cầu.
   */
  async requestContact(userId: string, contactId: string): Promise<{ status: 'pending' | 'accepted'; contacts: string[] }> {
    if (contactId === userId) throw new BadRequestException({ message: 'You cannot add yourself as a contact', code: 'messaging.contact_self' });
    await this.users.getUser(contactId);
    if (await this.repo.isContact(userId, contactId)) {
      return { status: 'accepted', contacts: await this.repo.listContacts(userId) };
    }
    if (await this.repo.isBlocked(contactId, userId) || await this.repo.isBlocked(userId, contactId)) {
      throw new ForbiddenException({ message: 'A block between you and this user prevents contact requests', code: 'messaging.contact_blocked' });
    }
    if (await this.repo.getContactRequest(contactId, userId)) {
      // Phía kia đã xin kết bạn với mình trước: gửi ngược lại = đồng ý.
      await this.repo.deleteContactRequest(contactId, userId);
      await this.repo.addContactPair(userId, contactId);
      return { status: 'accepted', contacts: await this.repo.listContacts(userId) };
    }
    const existing = await this.repo.getContactRequest(userId, contactId);
    if (!existing) {
      await this.repo.createContactRequest(userId, contactId);
      await this.notifications.notify(contactId, 'contact_request', {
        subject: 'New contact request',
        body: 'You have a new contact request. Open your messages to accept or decline it.',
        fromUserId: userId,
      });
    }
    return { status: 'pending', contacts: await this.repo.listContacts(userId) };
  }

  /**
   * Các yêu cầu kết bạn của tôi: `incoming` là yêu cầu người khác gửi
   * tới chờ tôi duyệt, `outgoing` là yêu cầu tôi đã gửi đang chờ.
   * Mỗi mục kèm tên hiển thị + username của phía kia để giao diện
   * hiện TÊN thay cho UUID thô.
   */
  async listContactRequests(userId: string): Promise<{
    incoming: { userId: string; createdAt: Date; displayName: string; username: string }[];
    outgoing: { userId: string; createdAt: Date; displayName: string; username: string }[];
  }> {
    const incoming = await this.repo.listIncomingContactRequests(userId);
    const outgoing = await this.repo.listOutgoingContactRequests(userId);
    const profiles = await this.profilesFor([
      ...incoming.map((r) => r.userIdFrom),
      ...outgoing.map((r) => r.userIdTo),
    ]);
    const withProfile = (id: string, createdAt: Date) => ({
      userId: id,
      createdAt,
      displayName: profiles[id]?.displayName ?? id,
      username: profiles[id]?.username ?? '',
    });
    return {
      incoming: incoming.map((r) => withProfile(r.userIdFrom, r.createdAt)),
      outgoing: outgoing.map((r) => withProfile(r.userIdTo, r.createdAt)),
    };
  }

  /**
   * Tóm tắt hiển thị (tên + username) cho một tập user id — các
   * response danh sách của messaging trả kèm để client hiện TÊN thay
   * cho UUID thô. User không còn tồn tại thì vắng khỏi bản đồ kết quả.
   */
  async profilesFor(userIds: string[]): Promise<Record<string, PersonSummaryView>> {
    const unique = [...new Set(userIds)];
    const out: Record<string, PersonSummaryView> = {};
    if (!unique.length) return out;
    const rows = await this.users.getUsersByIds(unique);
    for (const row of rows) {
      out[row.id] = { userId: row.id, displayName: displayNameOf(row), username: row.username };
    }
    return out;
  }

  /**
   * Hồ sơ người phục vụ panel thông tin của chat 1–1 (issue #592):
   * định danh + tên hiển thị + tên đăng nhập + email từ bảng người
   * dùng thật. Các trường panel khác (giới thiệu, điện thoại,
   * website, công ty, quốc gia, múi giờ, địa điểm, trạng thái sẵn
   * sàng, các thẻ, dòng vai trò) KHÔNG có nguồn trong hệ nên
   * không nằm trong kết quả — client giữ chúng qua adapter với
   * giá trị rỗng, không bịa dữ kiện.
   *
   * Cổng: người xem phải chung ít nhất một conversation NHÌN THẤY
   * ĐƯỢC với đối tác (xem repository) — người lạ không chung hội
   * thoại nào, và đối tác của hội thoại 1–1 đang chặn, đều nhận
   * 404 như đối tác không tồn tại (không rò sự tồn tại). Chính chủ
   * xem hồ sơ của mình luôn được phép. Email chỉ lộ trong phạm vi
   * quan hệ hội thoại này — khác với tóm tắt hiển thị dùng chung
   * (không có email) và khác với endpoint hồ sơ chung của module
   * users (gác bằng capability xem định danh).
   *
   * @param viewerId - Người xem hồ sơ.
   * @param targetId - Người cần xem hồ sơ.
   * @returns Hồ sơ người theo hợp đồng panel chat.
   * @throws {NotFoundException} `messaging.person_profile_not_found`
   *   khi đối tác không tồn tại hoặc không chung conversation nhìn
   *   thấy được với người xem.
   */
  async getPersonProfile(viewerId: string, targetId: string): Promise<{ userId: string; displayName: string; username: string; email: string }> {
    if (viewerId !== targetId && !(await this.repo.sharesConversation(viewerId, targetId))) {
      throw new NotFoundException({ message: `Person profile ${targetId} not found`, code: 'messaging.person_profile_not_found' });
    }
    const row = await this.users.getUser(targetId);
    return { userId: row.id, displayName: displayNameOf(row), username: row.username, email: row.email };
  }

  /**
   * Chấp nhận yêu cầu kết bạn TỪ requesterId: quan hệ hình thành ở cả
   * hai chiều, yêu cầu rời hàng chờ. Không có yêu cầu như vậy thì 404.
   */
  async acceptContactRequest(userId: string, requesterId: string): Promise<{ contacts: string[] }> {
    await this.users.getUser(requesterId);
    const request = await this.repo.getContactRequest(requesterId, userId);
    if (!request) throw new NotFoundException({ message: `No pending contact request from ${requesterId}`, code: 'messaging.contact_request_not_found' });
    await this.repo.deleteContactRequest(requesterId, userId);
    await this.repo.addContactPair(userId, requesterId);
    return { contacts: await this.repo.listContacts(userId) };
  }

  /**
   * Từ chối yêu cầu kết bạn TỪ requesterId: yêu cầu biến mất, quan hệ
   * không hình thành. Không có yêu cầu như vậy thì 404.
   */
  async declineContactRequest(userId: string, requesterId: string): Promise<{ declined: boolean }> {
    await this.users.getUser(requesterId);
    const request = await this.repo.getContactRequest(requesterId, userId);
    if (!request) throw new NotFoundException({ message: `No pending contact request from ${requesterId}`, code: 'messaging.contact_request_not_found' });
    await this.repo.deleteContactRequest(requesterId, userId);
    return { declined: true };
  }

  /**
   * Gỡ một liên hệ đã duyệt: quan hệ mất ở CẢ hai phía (cổng liên lạc
   * đóng lại cho cả hai chiều), yêu cầu chờ giữa hai người cũng dọn.
   */
  async removeContact(userId: string, contactId: string): Promise<{ contacts: string[] }> {
    await this.users.getUser(contactId);
    await this.repo.removeContactPair(userId, contactId);
    return { contacts: await this.repo.listContacts(userId) };
  }

  /**
   * Danh bạ của tôi (chỉ các liên hệ ĐÃ ĐƯỢC DUYỆT).
   */
  async listContacts(userId: string): Promise<string[]> {
    return this.repo.listContacts(userId);
  }

  // --- cổng liên lạc: chỉ liên hệ đã duyệt -------------------------------------

  /**
   * Cổng liên lạc 1-1 (đã chốt lại 24/10/2026 trên issue #33, thay mô
   * hình cũ "liên hệ hoặc cùng khoá" và thay luôn hiệu lực của setting
   * `core/messagingallusers`): người gửi chỉ nhắn riêng được với
   * người nhận khi hai người là liên hệ ĐÃ ĐƯỢC DUYỆT của nhau (luồng
   * yêu cầu–chấp nhận của Lớp B — yêu cầu đang chờ không mở cổng).
   * Cùng khoá KHÔNG còn mở cổng cho học sinh với nhau: bạn cùng lớp
   * muốn nhắn riêng phải kết bạn qua roster thành viên khoá trước.
   * Kiểm này là một tra cứu `isContact` theo khoá chính (đội kiểm tra
   * đo 0,018 ms — không nghẽn). Notification hệ thống (`notify`)
   * KHÔNG đi qua cổng này.
   *
   * NGOẠI LỆ duy nhất (chốt bổ sung 25/10/2026 trên issue
   * #33): cặp GIÁO VIÊN ↔ HỌC SINH thuộc cùng một đơn vị học tập
   * nhắn riêng trực tiếp không cần kết bạn — cả mở hội thoại mới
   * lẫn gửi vào hội thoại cũ, cả hai chiều (học sinh trả lời được).
   * Ngoại lệ có HAI căn cứ quan hệ thật, tính lại tại MỖI lần kiểm:
   * (a) cấp KHOÁ — gán vai dạy tại context khoá + ghi danh hiệu lực
   * (xem {@link MessagingRepository.findTeacherStudentSharedCourseId});
   * (b) cấp LỚP — gán vai dạy tại context lớp + thành viên roster
   * hiệu lực, bổ sung ở lát MSG-T2 theo sổ quyết định mục D ("HS
   * thuộc khoá/LỚP của mình") (xem
   * {@link MessagingRepository.findTeacherStudentSharedClassId}).
   * Hết quan hệ (rời lớp/hết ghi danh/hết vai dạy) thì cổng đóng
   * lại ngay, lịch sử cũ vẫn đọc được như luật gỡ liên hệ.
   * Quan hệ CHẶN vẫn thắng ngoại lệ này ở cả hai chiều: đã chặn thì
   * cặp GV–HS cũng không qua được (đường gửi vốn đã chặn bằng mã
   * `messaging.contact_blocked` trước khi tới đây; kiểm thêm tại đây
   * để đường MỞ hội thoại mới khép cùng một luật).
   *
   * @param senderId - Người mở hội thoại/gửi tin.
   * @param recipientId - Người nhận.
   * @returns Không trả dữ liệu; trở về bình thường nghĩa là cổng mở.
   * @throws {ForbiddenException} `messaging.not_a_contact` khi hai
   *   người không phải liên hệ đã duyệt và không có quan hệ GV–HS
   *   hiệu lực ở cấp khoá lẫn cấp lớp (hoặc đã chặn nhau).
   */
  async assertCanContact(senderId: string, recipientId: string): Promise<void> {
    if (await this.repo.isContact(recipientId, senderId)) return;
    const blockedEitherWay = (await this.repo.isBlocked(senderId, recipientId))
      || (await this.repo.isBlocked(recipientId, senderId));
    if (!blockedEitherWay && await this.repo.findTeacherStudentSharedCourseId(senderId, recipientId)) return;
    // Cùng ngoại lệ ở cấp LỚP (sổ mục D: HS thuộc khoá/LỚP của mình):
    // giáo viên của lớp ↔ thành viên roster hiệu lực của lớp.
    if (!blockedEitherWay && await this.repo.findTeacherStudentSharedClassId(senderId, recipientId)) return;
    throw new ForbiddenException({
      message: 'You can only message a contact directly — send a contact request from the course member list and wait for it to be accepted',
      code: 'messaging.not_a_contact',
    });
  }

  // --- liên hệ bị chặn ---------------------------------------------------------

  /**
   * Chặn một liên hệ.
   */
  async blockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    if (blockedUserId === userId) throw new BadRequestException({ message: 'You cannot block yourself', code: 'messaging.block_self' });
    await this.users.getUser(blockedUserId);
    await this.repo.block(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }

  /**
   * Bỏ chặn liên hệ.
   */
  async unblockContact(userId: string, blockedUserId: string): Promise<{ blocked: string[] }> {
    await this.repo.unblock(userId, blockedUserId);
    // Nối lại room 1–1 (tiếp quản PR #94): bỏ chặn phải khôi phục
    // nguyên trạng cho socket đang nối — xem rejoinDirectConversationAfterUnblock.
    await this.realtime.rejoinDirectConversationAfterUnblock(userId, blockedUserId);
    return { blocked: await this.repo.listBlocked(userId) };
  }

  /**
   * Danh sách liên hệ bị chặn.
   */
  async listBlocked(userId: string): Promise<string[]> {
    return this.repo.listBlocked(userId);
  }

  /**
   * User có bị người kia chặn hay không.
   */
  async isBlockedBy(blockerId: string, senderId: string): Promise<boolean> {
    return this.repo.isBlocked(blockerId, senderId);
  }
}
