/**
 * Rate limit tối thiểu của MCP-0 (hồ sơ research Phần 3.3): đếm theo
 * (giáo viên, nhóm tool) trong cửa sổ một giờ, giữ trong tiến trình
 * (stateless theo request nên không cần kho dùng chung ở lát này;
 * MCP-1 khi mở cho giáo viên thật sẽ xét lại theo AS/token family).
 * Đọc: 300 req/giờ; create_question: 120 câu/giờ — cấu hình qua env
 * MCP_RATE_READ_PER_HOUR / MCP_RATE_CREATE_PER_HOUR.
 */
export type McpRateBucket = 'read' | 'create' | 'publish';

export interface McpRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const WINDOW_MS = 60 * 60 * 1000;

export class McpRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limits: Record<McpRateBucket, number> = { read: 300, create: 120, publish: 10 },
  ) {}

  static bucketForTool(toolName: string | undefined): McpRateBucket {
    // Publish đổi trạng thái phát hành (draft → ready) nên có xô riêng
    // siết nhất (hồ sơ 3.3: 10 lần/giờ). Mọi tool GHI còn lại dùng xô
    // 'create' (submit_contribution gộp nhiều câu trong một call vẫn
    // tính theo lượt gọi, phần số câu do cổng nghiệp vụ QB-4 +
    // idempotency giữ; riêng batch của MCP-1 tính theo SỐ ITEM qua
    // tham số cost ở mount).
    if (toolName === 'publish_questions') return 'publish';
    return toolName === 'create_question' ||
      toolName === 'create_questions_batch' ||
      toolName === 'create_stimulus_with_questions' ||
      toolName === 'submit_contribution'
      ? 'create'
      : 'read';
  }

  /**
   * `cost` = số đơn vị tính vào hạn mức của lượt gọi này (mặc định 1;
   * batch truyền số item để hạn mức 120 câu/giờ tính theo câu thật
   * như hồ sơ 3.3, không theo số request).
   */
  check(userId: string, bucket: McpRateBucket, now = Date.now(), cost = 1): McpRateDecision {
    const key = `${userId}:${bucket}`;
    const limit = this.limits[bucket];
    const units = Math.max(1, Math.floor(cost) || 1);
    const current = this.windows.get(key);
    if (!current || now - current.windowStart >= WINDOW_MS) {
      this.windows.set(key, { windowStart: now, count: units });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count + units > limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.windowStart + WINDOW_MS - now) / 1000)),
      };
    }
    current.count += units;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
