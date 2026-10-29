/**
 * Định danh room realtime của messaging — NHÀ DUY NHẤT của luật đặt
 * tên room (issue #521): phía API (gateway gắn socket vào room lúc
 * bắt tay) và phía worker (consumer phân phối phát sự kiện vào room)
 * là hai tiến trình riêng, cùng import các hàm này từ package dùng
 * chung để tên room không bao giờ lệch nhau giữa nơi nối và nơi phát.
 */

/**
 * Đoạn namespace tenant trong mọi định danh realtime (TENANT-1,
 * #196): room Socket.IO và khoá Redis presence/typing đều bắt đầu
 * bằng tenant để hai tenant không bao giờ chung một kênh phát — kể
 * cả khi id conversation/user tình cờ va nhau ở tầng ứng dụng.
 * Tenant chưa rõ (dữ liệu cũ) rơi về đoạn 'platform'.
 */
export function tenantRealtimeSegment(tenantId: string | null | undefined): string {
  return tenantId ?? 'platform';
}

/** Room của một conversation: mọi thành viên đang nối đều ở trong room này. */
export function conversationRoom(tenantId: string | null | undefined, conversationId: string): string {
  return `t:${tenantRealtimeSegment(tenantId)}:conv:${conversationId}`;
}

/** Room riêng của một user: nhận cập nhật theo từng người (số chưa đọc của chính họ). */
export function userRoom(tenantId: string | null | undefined, userId: string): string {
  return `t:${tenantRealtimeSegment(tenantId)}:user:${userId}`;
}
