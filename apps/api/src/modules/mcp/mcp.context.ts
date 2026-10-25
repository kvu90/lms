/**
 * Bối cảnh một request MCP đã qua cầu auth (MCP-0, issue #110): danh tính
 * giáo viên chủ token + định danh client AI tự giới thiệu. Mọi tool chạy
 * với actor này — không có "tài khoản AI" riêng, token luôn là của chính
 * giáo viên (hồ sơ research MCP Phần 2.2/3.3).
 */
export interface McpActor {
  userId: string;
  username: string;
  /**
   * Tenant của PHIÊN gọi (TENANT-1, #196): lấy từ claim `tid` của
   * token (đường bridge) hoặc phân giải từ membership của user
   * (đường OAuth khi token AS không mang tid). Mount nạp tenant này
   * vào ALS cho toàn lượt gọi tool — service/RLS tự giới hạn dữ
   * liệu trong tenant (bank đích của tool ghi phân giải trong đúng
   * tenant của phiên, không còn đường đọc/ghi xuyên tenant).
   */
  tenantId: string | null;
  /** client_id suy từ clientInfo của client MCP (cầu auth tạm — MCP-1 AS sẽ cấp client_id thật qua token). */
  clientId: string;
  ip: string | null;
  era: 'legacy' | 'modern';
  /**
   * Trần quyền OAuth của phiên gọi (authInfo.scopes): kỷ nguyên cầu
   * auth = tập scope mount cấp cho token hệ thống; MCP-1 AS sẽ là scope
   * trên access token thật. Tool ghi có scope riêng (vd
   * `lms.banks.contribute`) phải tự đối chiếu trần này — quyền nghiệp
   * vụ thật vẫn là capability tại context như REST.
   */
  scopes: string[];
}
