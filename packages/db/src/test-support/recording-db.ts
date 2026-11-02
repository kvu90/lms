/**
 * Handle Kysely "ghi lại" cho các ca đơn vị của các repository kho
 * trung tâm (issue #649): một driver tối thiểu chỉ ghi lại câu SQL
 * đã biên dịch + tham số của mọi truy vấn được thực thi và trả về
 * tập dòng rỗng, để spec khoá HÌNH DẠNG SQL (vị trí điều kiện trong
 * ON/WHERE, cột nào có mặt trong values/set) mà không cần database.
 *
 * Đây không phải mô phỏng hành vi database: ngữ nghĩa chạy thật
 * (kết quả đúng trên dữ kiện mẫu) được khoá ở các spec tích hợp
 * `*.int-spec.ts` đi kèm trên PostgreSQL thật. Driver này chỉ trả
 * lời câu hỏi "repository biên dịch ra câu SQL nào".
 */
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { CentreDb, CentreDB } from '../client';

/** Driver ghi lại mọi câu truy vấn đã biên dịch; kết nối của nó luôn trả tập dòng rỗng. */
class RecordingDriver implements Driver {
  /** Mọi câu truy vấn đã biên dịch theo thứ tự thực thi. */
  readonly queries: CompiledQuery[] = [];

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const queries = this.queries;
    return {
      executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> => {
        queries.push(compiled);
        return { rows: [] };
      },
      streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
        // Kết nối ghi lại không phát dòng nào: luồng truy vấn kết
        // thúc ngay (vẫn giữ dạng generator cho đúng hợp đồng).
        yield* [];
      },
    };
  }

  async beginTransaction(): Promise<void> {}

  async commitTransaction(): Promise<void> {}

  async rollbackTransaction(): Promise<void> {}

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/**
 * Dựng một handle Kysely của kho trung tâm trên driver ghi lại,
 * cùng chính driver đó để spec đọc lại các câu đã biên dịch.
 */
export function createRecordingDb(): { db: CentreDb; driver: RecordingDriver } {
  const driver = new RecordingDriver();
  const db = new Kysely<CentreDB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (instance) => new PostgresIntrospector(instance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, driver };
}
