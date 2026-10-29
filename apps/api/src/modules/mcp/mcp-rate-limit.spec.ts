import { describe, expect, it } from 'vitest';
import { McpRateLimiter } from './mcp-rate-limit';

/**
 * Kiểm chứng bộ giới hạn tần suất MCP (issue #485) ở mức đơn vị:
 * - Quyết định cho phép/chặn và `retryAfterSeconds` quanh biên cửa sổ
 *   một giờ phải giữ nguyên tuyệt đối trước và sau khi sửa rò bộ nhớ
 *   (cùng cửa sổ, cùng ngưỡng, cùng cách tính phần chờ còn lại).
 * - Entry của khoá đã hết hạn cửa sổ phải bị xoá khỏi Map lưu cửa sổ
 *   ngay trong phép kiểm tra, để kích thước Map bị chặn bởi số khoá
 *   đang còn trong cửa sổ hiệu lực — trước khi sửa, Map giữ vĩnh viễn
 *   mọi khoá từng gọi tới và phình không giới hạn theo số client.
 *
 * Mọi ca đều lái thời gian qua tham số `now` của `check` nên không phụ
 * thuộc đồng hồ thật. Kích thước Map được đọc qua ép kiểu có chủ đích:
 * quyết định cho/chặn cố ý giữ giống hệt hành vi cũ, nên độ phình của
 * Map là bề mặt quan sát duy nhất của chính lỗi rò bộ nhớ này.
 */
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

type WindowsMap = Map<string, { windowStart: number; count: number }>;

function windowsOf(limiter: McpRateLimiter): WindowsMap {
  return (limiter as unknown as { windows: WindowsMap }).windows;
}

describe('McpRateLimiter — quyết định cho phép/chặn trong cửa sổ', () => {
  it('cho phép các lượt gọi trong hạn mức và chặn lượt vượt hạn với retryAfterSeconds bằng phần còn lại của cửa sổ', () => {
    const limiter = new McpRateLimiter({ read: 3, create: 120, publish: 10 });
    expect(limiter.check('u1', 'read', T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check('u1', 'read', T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.check('u1', 'read', T0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // Lượt thứ 4 vượt hạn 3: bị chặn, phải chờ trọn phần cửa sổ còn lại.
    expect(limiter.check('u1', 'read', T0)).toEqual({ allowed: false, retryAfterSeconds: 3600 });
    // Sau 1 giây, phần chờ còn lại giảm đúng 1 giây.
    expect(limiter.check('u1', 'read', T0 + 1000)).toEqual({ allowed: false, retryAfterSeconds: 3599 });
  });

  it('ngay trước biên cửa sổ vẫn chặn, đúng tại biên cửa sổ thì cho phép và đếm lại từ đầu', () => {
    const limiter = new McpRateLimiter({ read: 1, create: 120, publish: 10 });
    expect(limiter.check('u1', 'read', T0).allowed).toBe(true);
    // 1 ms trước biên: vẫn trong cửa sổ cũ, bị chặn và chờ 1 giây (làm tròn lên).
    expect(limiter.check('u1', 'read', T0 + HOUR_MS - 1)).toEqual({
      allowed: false,
      retryAfterSeconds: 1,
    });
    // Đúng tại biên: cửa sổ mới bắt đầu, cho phép lại.
    expect(limiter.check('u1', 'read', T0 + HOUR_MS)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // Bộ đếm của cửa sổ mới bắt đầu lại từ đầu: lượt kế tiếp chạm hạn 1 ngay.
    expect(limiter.check('u1', 'read', T0 + HOUR_MS).allowed).toBe(false);
  });

  it('tính hạn mức theo cost: batch cộng dồn số item, cost nhỏ hơn 1 tính là 1 và cost lẻ làm tròn xuống', () => {
    const limiter = new McpRateLimiter({ read: 300, create: 5, publish: 10 });
    expect(limiter.check('u1', 'create', T0, 2).allowed).toBe(true); // đã dùng 2/5
    expect(limiter.check('u1', 'create', T0, 2).allowed).toBe(true); // đã dùng 4/5
    expect(limiter.check('u1', 'create', T0, 2).allowed).toBe(false); // 4 + 2 vượt hạn 5
    expect(limiter.check('u1', 'create', T0, 1).allowed).toBe(true); // vừa đủ 5/5
    expect(limiter.check('u1', 'create', T0, 1).allowed).toBe(false);
    // cost = 0 vẫn tính 1 đơn vị (sàn của lượt gọi).
    expect(limiter.check('u2', 'create', T0, 0).allowed).toBe(true); // 1/5
    expect(limiter.check('u2', 'create', T0, 4).allowed).toBe(true); // 5/5
    expect(limiter.check('u2', 'create', T0, 1).allowed).toBe(false);
    // cost lẻ làm tròn xuống: 2.9 tính là 2.
    expect(limiter.check('u3', 'create', T0, 2.9).allowed).toBe(true); // 2/5
    expect(limiter.check('u3', 'create', T0, 3).allowed).toBe(true); // 5/5
    expect(limiter.check('u3', 'create', T0, 1).allowed).toBe(false);
  });

  it('các xô hạn mức độc lập với nhau và các người dùng độc lập với nhau', () => {
    const limiter = new McpRateLimiter({ read: 300, create: 1, publish: 10 });
    expect(limiter.check('u1', 'create', T0).allowed).toBe(true);
    expect(limiter.check('u1', 'create', T0).allowed).toBe(false); // u1 chạm hạn create
    expect(limiter.check('u1', 'read', T0).allowed).toBe(true); // xô read của u1 chưa bị ảnh hưởng
    expect(limiter.check('u2', 'create', T0).allowed).toBe(true); // người dùng khác có hạn mức riêng
  });

  it('ánh xạ tool sang đúng xô: publish_questions vào publish, các tool ghi câu hỏi vào create, còn lại vào read', () => {
    expect(McpRateLimiter.bucketForTool('publish_questions')).toBe('publish');
    expect(McpRateLimiter.bucketForTool('create_question')).toBe('create');
    expect(McpRateLimiter.bucketForTool('create_questions_batch')).toBe('create');
    expect(McpRateLimiter.bucketForTool('create_stimulus_with_questions')).toBe('create');
    expect(McpRateLimiter.bucketForTool('submit_contribution')).toBe('create');
    expect(McpRateLimiter.bucketForTool('list_questions')).toBe('read');
    expect(McpRateLimiter.bucketForTool(undefined)).toBe('read');
  });
});

describe('McpRateLimiter — dọn entry hết hạn khỏi Map cửa sổ', () => {
  it('xoá entry đã hết hạn khỏi Map khi một phép kiểm tra khác chạy sau thời điểm hết hạn', () => {
    const limiter = new McpRateLimiter({ read: 300, create: 120, publish: 10 });
    limiter.check('u1', 'read', T0);
    expect(windowsOf(limiter).size).toBe(1);
    // Sau khi cửa sổ của u1 đã hết hạn, một lượt gọi của khoá khác phải
    // dọn entry của u1: Map chỉ còn entry của khoá đang hoạt động.
    limiter.check('u2', 'read', T0 + HOUR_MS + 1000);
    expect(windowsOf(limiter).size).toBe(1);
    expect(windowsOf(limiter).has('u1:read')).toBe(false);
    expect(windowsOf(limiter).has('u2:read')).toBe(true);
  });

  it('giữ nguyên entry và bộ đếm của khoá còn trong cửa sổ khi dọn entry đã hết hạn', () => {
    const limiter = new McpRateLimiter({ read: 300, create: 120, publish: 2 });
    limiter.check('userA', 'publish', T0); // cửa sổ của A bắt đầu tại T0
    limiter.check('userB', 'publish', T0 + HOUR_MS / 2); // cửa sổ của B bắt đầu muộn hơn nửa cửa sổ
    limiter.check('userB', 'publish', T0 + HOUR_MS / 2); // B dùng đủ hạn 2/2
    // Tại T0 + 1 giờ + 1 giây: cửa sổ của A đã hết hạn, cửa sổ của B còn nửa sau.
    const now = T0 + HOUR_MS + 1000;
    limiter.check('userC', 'publish', now); // lượt gọi này kích hoạt việc dọn
    // Chỉ entry của A bị xoá; entry của B (còn hiệu lực) và của C ở lại.
    expect(windowsOf(limiter).size).toBe(2);
    expect(windowsOf(limiter).has('userA:publish')).toBe(false);
    // Bộ đếm của B không bị dọn/reset: B vẫn bị chặn với phần chờ của cửa sổ riêng.
    expect(limiter.check('userB', 'publish', now)).toEqual({
      allowed: false,
      retryAfterSeconds: 1799,
    });
  });

  it('kích thước Map không tăng đơn điệu khi nhiều khoá khác nhau gọi qua nhiều cửa sổ liên tiếp', () => {
    const limiter = new McpRateLimiter({ read: 300, create: 120, publish: 10 });
    const keysPerWindow = 20;
    const windowCount = 5;
    for (let round = 0; round < windowCount; round++) {
      const now = T0 + round * (HOUR_MS + 1);
      for (let i = 0; i < keysPerWindow; i++) {
        limiter.check(`user-r${round}-${i}`, 'read', now);
      }
      // Sau mỗi cửa sổ, Map chỉ còn các khoá của cửa sổ hiện tại —
      // các khoá của cửa sổ trước đã hết hạn và bị dọn.
      expect(windowsOf(limiter).size).toBe(keysPerWindow);
    }
    // Tổng cộng 100 khoá khác nhau đã gọi qua 5 cửa sổ, Map vẫn bị chặn ở 20.
    expect(windowsOf(limiter).size).toBe(20);
  });
});
