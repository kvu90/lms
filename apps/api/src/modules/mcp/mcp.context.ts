/**
 * Bối cảnh một request MCP đã qua cầu auth (MCP-0, issue #110): danh tính
 * giáo viên chủ token + định danh client AI tự giới thiệu. Mọi tool chạy
 * với actor này — không có "tài khoản AI" riêng, token luôn là của chính
 * giáo viên (hồ sơ research MCP Phần 2.2/3.3).
 */
export interface McpActor {
  userId: string;
  username: string;
  /** client_id suy từ clientInfo của client MCP (cầu auth tạm — MCP-1 AS sẽ cấp client_id thật qua token). */
  clientId: string;
  ip: string | null;
  era: 'legacy' | 'modern';
}
