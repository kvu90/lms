/**
 * Rate limit tối thiểu của MCP-0 (hồ sơ research Phần 3.3): đếm theo
 * (giáo viên, nhóm tool) trong cửa sổ một giờ, giữ trong tiến trình
 * (stateless theo request nên không cần kho dùng chung ở lát này;
 * MCP-1 khi mở cho giáo viên thật sẽ xét lại theo AS/token family).
 * Đọc: 300 req/giờ; create_question: 120 câu/giờ — cấu hình qua env
 * MCP_RATE_READ_PER_HOUR / MCP_RATE_CREATE_PER_HOUR.
 */
export type McpRateBucket = 'read' | 'create';

export interface McpRateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const WINDOW_MS = 60 * 60 * 1000;

export class McpRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limits: Record<McpRateBucket, number> = { read: 300, create: 120 },
  ) {}

  static bucketForTool(toolName: string | undefined): McpRateBucket {
    return toolName === 'create_question' ? 'create' : 'read';
  }

  check(userId: string, bucket: McpRateBucket, now = Date.now()): McpRateDecision {
    const key = `${userId}:${bucket}`;
    const limit = this.limits[bucket];
    const current = this.windows.get(key);
    if (!current || now - current.windowStart >= WINDOW_MS) {
      this.windows.set(key, { windowStart: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.windowStart + WINDOW_MS - now) / 1000)),
      };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
