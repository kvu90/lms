/**
 * Repository của bảng MCP IDEMPOTENCY trên Kysely — chuyển đổi
 * Drizzle → Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ
 * liệu (issue #648).
 *
 * Vai trò: truy cập bảng `mcp_idempotency_keys` của kho trung tâm
 * — tra cứu có xét hạn: dòng hết hạn bị xoá ngay khi chạm tới và
 * coi như không tồn tại, để client dùng lại key sau 24 giờ không
 * va phải response cũ. Repository không chứa luật nghiệp vụ MCP;
 * hạn 24 giờ là hằng số của chính bảng này nên giữ tại đây như
 * trước.
 *
 * Khuôn theo pilot kho control plane: tên cột snake_case của
 * schema codegen ở bên trong, hình dạng dòng camelCase ở biên qua
 * danh sách cột có bí danh tường minh; cột jsonb `response_json`
 * khi ghi đi qua `jsonbValue` (serialize tường minh + `::jsonb`)
 * để một khuôn duy nhất cho mọi giá trị jsonb.
 */
import { sql, type RawBuilder } from 'kysely';
import type { CentreDb, CentreTx } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type McpIdempotencyDb = CentreDb | CentreTx;

/** Một dòng khoá idempotency của MCP (response đã lưu nằm ở cột jsonb responseJson). */
export interface McpIdempotencyKeyRow {
  id: string;
  userId: string;
  key: string;
  tool: string;
  requestHash: string;
  /** Response đã lưu của lần gọi đầu (jsonb). */
  responseJson: unknown;
  createdAt: Date;
  expiresAt: Date;
}

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + `::jsonb`) — xem lý do ở phần đầu file.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb (hình
 *   dạng do phía gọi chịu trách nhiệm — các cột jsonb của cụm này
 *   không khai kiểu nghiệp vụ riêng ở schema).
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng mcp_idempotency_keys. */
const MCP_IDEMPOTENCY_KEY_COLUMNS = [
  'id',
  'user_id as userId',
  'key',
  'tool',
  'request_hash as requestHash',
  'response_json as responseJson',
  'created_at as createdAt',
  'expires_at as expiresAt',
] as const;

/**
 * Truy cập bảng `mcp_idempotency_keys`: tra cứu có xét hạn — dòng hết hạn bị
 * xoá ngay khi chạm tới và coi như không tồn tại, để client dùng lại key
 * sau 24 giờ không va phải response cũ.
 */
export class McpIdempotencyRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Tra khoá của một user: hết hạn thì xoá dòng và trả null như chưa từng có. */
  async find(userId: string, key: string, db: McpIdempotencyDb = this.handle): Promise<McpIdempotencyKeyRow | null> {
    const row = await db
      .selectFrom('mcp_idempotency_keys')
      .select(MCP_IDEMPOTENCY_KEY_COLUMNS)
      .where('user_id', '=', userId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await db
        .deleteFrom('mcp_idempotency_keys')
        .where('id', '=', row.id)
        .execute();
      return null;
    }
    return row;
  }

  /** Lưu response của lần gọi đầu cho một khoá, hạn dùng 24 giờ. */
  async store(input: {
    userId: string;
    key: string;
    tool: string;
    requestHash: string;
    response: Record<string, unknown>;
  }, db: McpIdempotencyDb = this.handle): Promise<void> {
    const now = new Date();
    await db
      .insertInto('mcp_idempotency_keys')
      .values({
        user_id: input.userId,
        key: input.key,
        tool: input.tool,
        request_hash: input.requestHash,
        response_json: jsonbValue(input.response),
        created_at: now,
        expires_at: new Date(now.getTime() + TTL_MS),
      })
      .execute();
  }

  /** Xoá mọi dòng đã hết hạn (gọi cơ hội khi tra cứu; job dọn định kỳ để lát sau). */
  async purgeExpired(db: McpIdempotencyDb = this.handle): Promise<void> {
    await db
      .deleteFrom('mcp_idempotency_keys')
      .where('expires_at', '<=', new Date())
      .execute();
  }
}
