import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { tenantAls } from '../modules/tenants/tenant-als';

/**
 * Pool PostgreSQL gắn ngữ cảnh tenant vào mọi kết nối (TENANT-1, #196).
 *
 * Vì sao ở tầng pool: 102 điểm inject `Database` trong API dùng chung
 * một pool của Drizzle và chạy truy vấn trực tiếp trên pool (không qua
 * transaction bọc theo request). RLS fail-closed đòi hỏi MỌI truy vấn
 * trên các bảng mang `tenant_id` phải chạy với GUC đã đặt; đặt GUC ở
 * đây — một điểm duy nhất — là cơ chế tương đương wrapper: khi một kết
 * nối được checkout trong lúc ALS `tenantAls` mang ngữ cảnh tenant
 * (TenantGuard/TenantContextInterceptor nạp cho request,
 * TenantDbService nạp cho job/consumer), câu truy vấn đầu tiên trên kết
 * nối đó được chèn trước một `set_config` mức phiên:
 *
 *   - ngữ cảnh tenant: `app.tenant_id = <tenant>`, `app.platform='off'`
 *   - ngữ cảnh platform tường minh: `app.platform = 'on'`
 *   - ngoài ngữ cảnh: `app.tenant_id = ''`, `app.platform = 'off'`
 *     (fail-closed: chỉ thấy dòng platform ở các bảng cho phép)
 *
 * GUC mức phiên (tham số thứ ba = false) vì một checkout không đồng
 * nghĩa một transaction: các truy vấn thường của Drizzle chạy ngoài
 * transaction tường minh. Client trả về pool rồi được checkout lại chỉ
 * CẬP NHẬT state gắn GUC (không bọc chồng hàm query) và gắn lại trước
 * câu truy vấn đầu tiên, nên GUC của ngữ cảnh trước không bao giờ rò
 * sang ngữ cảnh sau. Transaction tường minh (db.transaction) cũng
 * checkout qua đây: GUC phiên đặt trước BEGIN nên nhất quán trong
 * transaction, và `set_config(..., true)` trong TenantDbService vẫn
 * thắng ở phạm vi transaction.
 */
interface TenantTagState {
  tagged: boolean;
  tenantId: string;
  platform: string;
  rawQuery: (...args: unknown[]) => Promise<unknown>;
}

const TAG_STATE = Symbol('tenantTagState');

export class TenantAwarePool extends Pool {
  constructor(config: PoolConfig) {
    super(config);
  }

  /** Chuẩn bị state gắn GUC cho một client vừa checkout theo ngữ cảnh ALS hiện tại. */
  private prepareClient(client: PoolClient): PoolClient {
    const store = tenantAls.getStore();
    const tenantId = store?.platform ? '' : (store?.tenantId ?? '');
    const platform = store?.platform ? 'on' : 'off';
    const holder = client as PoolClient & { [TAG_STATE]?: TenantTagState };
    const existing = holder[TAG_STATE];
    if (existing) {
      // Client tái sử dụng từ pool: cập nhật đích GUC + buộc gắn lại ở
      // câu truy vấn đầu tiên của lượt checkout này.
      existing.tenantId = tenantId;
      existing.platform = platform;
      existing.tagged = false;
      return client;
    }
    const state: TenantTagState = {
      tagged: false,
      tenantId,
      platform,
      rawQuery: client.query.bind(client) as (...args: unknown[]) => Promise<unknown>,
    };
    holder[TAG_STATE] = state;
    client.query = (async (...args: unknown[]) => {
      if (!state.tagged) {
        await state.rawQuery(
          "select set_config('app.tenant_id', $1, false), set_config('app.platform', $2, false)",
          [state.tenantId, state.platform],
        );
        state.tagged = true;
      }
      return state.rawQuery(...args);
    }) as PoolClient['query'];
    return client;
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (err: Error, client: PoolClient, done: (release?: unknown) => void) => void,
  ): void;
  override connect(
    callback?: (err: Error, client: PoolClient, done: (release?: unknown) => void) => void,
  ): Promise<PoolClient> | void {
    if (callback) {
      // Dạng callback (pg dùng nội bộ cho pool.query): giữ nguyên hợp
      // đồng — client trao tay đã sẵn sàng gắn GUC ở câu query đầu.
      super.connect((err, client, done) => {
        if (err || !client)
          return callback(
            err ?? new Error('TenantAwarePool: connect failed'),
            client as PoolClient,
            done,
          );
        try {
          this.prepareClient(client);
        } catch (prepError) {
          done(prepError);
          return callback(prepError as Error, client, done);
        }
        return callback(null as unknown as Error, client, done);
      });
      return undefined;
    }
    return super.connect().then((client) => this.prepareClient(client));
  }
}
