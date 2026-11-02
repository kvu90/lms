/**
 * Repository của cụm NGƯỜI DÙNG trên Kysely — chuyển đổi Drizzle →
 * Kysely của chiến dịch chuyển tầng dữ liệu (issue #641, nhóm G1).
 *
 * Vai trò: mọi truy cập tới hai bảng `users` và `user_preferences`
 * của kho trung tâm tập trung ở đây. Repository không chứa luật
 * nghiệp vụ — chính sách mật khẩu, đồng bộ credential và sự kiện
 * outbox nằm ở tầng service phía ứng dụng; repository chỉ nhận
 * handle Kysely (instance gốc hoặc transaction đang mở) do tầng
 * ứng dụng truyền vào, và phơi đúng hai điểm ghép transaction mà
 * tầng service cần: `transaction(fn)` để mở transaction trên
 * handle gốc, và tham số `tx` tuỳ chọn ở các thao tác ghi để chạy
 * trong transaction do nơi gọi mở.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem `control-plane.ts` và playbook trong
 * `AGENTS.md` của package):
 * - Bên trong, truy vấn viết trên interface schema sinh bằng
 *   codegen: tên bảng/cột giữ nguyên snake_case của database.
 * - Bên ngoài, repository trả/nhận hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường
 *   minh có bí danh (`first_name as firstName`), giá trị ghi được
 *   ánh xạ từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues`/`*UpdateSet` trong file này.
 * - Giá trị `undefined` bị LOẠI khỏi values/set trước khi gọi
 *   builder (quy tắc T-4 của pilot): trường vắng mặt phải để
 *   default của database quyết định. Ngược lại, `undefined` lọt
 *   vào mệnh đề WHERE bị gắn thành NULL lúc thực thi và lặng lẽ
 *   trả 0 dòng — vì vậy điều kiện động của `search()` dựng bằng
 *   `eb.and(conds)` trên các biểu thức luôn có giá trị bắt buộc
 *   (mẫu an toàn của thử nghiệm T-13), không bao giờ truyền
 *   `where(undefined)`.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh
 *   ứng dụng, không tự mở pool: handle do tầng ứng dụng dựng (điểm
 *   lắp ráp là facade định tuyến theo không gian `routedKysely`)
 *   rồi truyền vào; ngữ cảnh trung tâm đi theo chính kết nối của
 *   handle đó.
 */
import { sql, type ExpressionBuilder, type Insertable, type Updateable } from 'kysely';
import type { UserListSortBy, UserListStatus } from '@lms/contracts';
import type { CentreDb, CentreDB, CentreTx } from '../client';

/** Một dòng người dùng (hình dạng camelCase phía tiêu thụ dùng). */
export interface UserRow {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  suspended: boolean;
  deleted: boolean;
  forcePasswordChange: boolean;
  isGuest: boolean;
  lastLogin: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện tạo người dùng mới (các trường có default ở database được phép vắng mặt). */
export interface NewUser {
  id?: string;
  username: string;
  email: string;
  emailVerified?: boolean;
  image?: string | null;
  passwordHash?: string | null;
  firstName?: string;
  lastName?: string;
  suspended?: boolean;
  deleted?: boolean;
  forcePasswordChange?: boolean;
  isGuest?: boolean;
  lastLogin?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Patch cập nhật hồ sơ người dùng — chỉ các trường có mặt mới được ghi. */
export type UserPatch = Partial<NewUser>;

/**
 * Bộ lọc danh sách người dùng cho `search()` — nhóm trạng thái và hợp đồng
 * sắp xếp, nhận giá trị theo hợp đồng truy vấn ở `@lms/contracts`. Mọi
 * trường đều tuỳ chọn; bỏ trống trường nào thì `search()` áp dụng hành vi
 * mặc định của trường đó như mô tả từng trường dưới đây.
 *
 * - `status`: nhóm trạng thái tài khoản cần lấy, suy ra từ hai cờ `deleted`
 *   và `suspended` của bản ghi người dùng. Không truyền thì chỉ lấy tài
 *   khoản chưa xoá (gồm cả tài khoản đang bị đình chỉ); `active` lấy tài
 *   khoản chưa xoá và không bị đình chỉ; `suspended` lấy tài khoản chưa xoá
 *   đang bị đình chỉ; `deleted` chỉ lấy tài khoản đã xoá mềm.
 * - `sortBy`: trường sắp xếp chính — `name` sắp theo `firstName` rồi
 *   `lastName`, `createdAt` theo thời điểm tạo tài khoản, `lastLogin` theo
 *   lần đăng nhập gần nhất. Không truyền thì giữ thứ tự mặc định theo `id`
 *   tăng dần; khi có truyền, `search()` luôn neo thêm `id` tăng dần ở cuối
 *   để thứ tự ổn định giữa các trang.
 * - `sortDirection`: chiều áp cho trường `sortBy` — `desc` là giảm dần, các
 *   trường hợp còn lại (kể cả không truyền) là tăng dần. Chỉ có tác dụng khi
 *   có `sortBy`; neo `id` ở cuối luôn tăng dần bất kể chiều này.
 */
export interface UserListFilter {
  status?: UserListStatus;
  sortBy?: UserListSortBy;
  sortDirection?: 'asc' | 'desc';
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng người dùng (dùng cho cả select lẫn returning). */
const USER_COLUMNS = [
  'id',
  'username',
  'email',
  'email_verified as emailVerified',
  'image',
  'password_hash as passwordHash',
  'first_name as firstName',
  'last_name as lastName',
  'suspended',
  'deleted',
  'force_password_change as forcePasswordChange',
  'is_guest as isGuest',
  'last_login as lastLogin',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Ánh xạ dữ kiện tạo người dùng (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường mang `undefined` — trường vắng mặt
 * để default của database quyết định (quy tắc T-4).
 */
function userInsertValues(values: NewUser): Insertable<CentreDB['users']> {
  const row: Insertable<CentreDB['users']> = {
    username: values.username,
    email: values.email,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.emailVerified !== undefined) row.email_verified = values.emailVerified;
  if (values.image !== undefined) row.image = values.image;
  if (values.passwordHash !== undefined) row.password_hash = values.passwordHash;
  if (values.firstName !== undefined) row.first_name = values.firstName;
  if (values.lastName !== undefined) row.last_name = values.lastName;
  if (values.suspended !== undefined) row.suspended = values.suspended;
  if (values.deleted !== undefined) row.deleted = values.deleted;
  if (values.forcePasswordChange !== undefined) row.force_password_change = values.forcePasswordChange;
  if (values.isGuest !== undefined) row.is_guest = values.isGuest;
  if (values.lastLogin !== undefined) row.last_login = values.lastLogin;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch hồ sơ (camelCase) sang set update (snake_case),
 * LOẠI mọi trường `undefined` — patch chỉ chứa trường nào thì chỉ
 * trường đó đổi, đúng ngữ nghĩa bỏ qua `undefined` của đường
 * Drizzle trước đây (quy tắc T-4). Mốc `updated_at` do repository
 * tự đóng dấu ở điểm gọi, không nằm trong hàm ánh xạ này.
 */
function userUpdateSet(patch: UserPatch): Updateable<CentreDB['users']> {
  const set: Updateable<CentreDB['users']> = {};
  if (patch.username !== undefined) set.username = patch.username;
  if (patch.email !== undefined) set.email = patch.email;
  if (patch.emailVerified !== undefined) set.email_verified = patch.emailVerified;
  if (patch.image !== undefined) set.image = patch.image;
  if (patch.passwordHash !== undefined) set.password_hash = patch.passwordHash;
  if (patch.firstName !== undefined) set.first_name = patch.firstName;
  if (patch.lastName !== undefined) set.last_name = patch.lastName;
  if (patch.suspended !== undefined) set.suspended = patch.suspended;
  if (patch.deleted !== undefined) set.deleted = patch.deleted;
  if (patch.forcePasswordChange !== undefined) set.force_password_change = patch.forcePasswordChange;
  if (patch.isGuest !== undefined) set.is_guest = patch.isGuest;
  if (patch.lastLogin !== undefined) set.last_login = patch.lastLogin;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Kho dữ liệu người dùng và tuỳ chọn cá nhân (user_preferences).
 */
export class UsersRepository {
  constructor(private readonly handle: CentreDb) {}

  /**
   * Handle gốc của repository — điểm ghép mà tầng service dùng để
   * mở transaction (`transaction(fn)` bên dưới) và cho các đường
   * đọc phụ trợ thuộc chính module người dùng. Handle này là
   * handle Kysely được định tuyến theo không gian, KHÔNG còn là
   * handle Drizzle: mọi thao tác ghép vào transaction mở từ đây
   * đều là thao tác Kysely trên cùng một transaction.
   */
  get dbHandle(): CentreDb { return this.handle; }

  /** Mở một transaction trên kho trung tâm và chạy `fn` trong đó (thành/bại cùng nhau). */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  /**
   * Chèn user mới (mật khẩu đã hash ở tầng service).
   */
  async insertUser(v: NewUser, tx?: CentreTx): Promise<UserRow> {
    const rows = await (tx ?? this.handle)
      .insertInto('users')
      .values(userInsertValues(v))
      .returning(USER_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /**
   * Cập nhật các trường hồ sơ của user; mốc `updated_at` luôn được
   * đóng dấu tại thời điểm ghi, kể cả khi patch mang sẵn mốc riêng.
   */
  async updateUser(id: string, v: UserPatch, tx?: CentreTx): Promise<void> {
    await (tx ?? this.handle)
      .updateTable('users')
      .set({ ...userUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Lấy user theo id.
   */
  async getById(id: string): Promise<UserRow | undefined> {
    return this.handle
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Lấy nhiều user theo danh sách id trong một truy vấn (phục vụ báo cáo/export cần thông tin người học hàng loạt).
   */
  async getByIds(ids: string[]): Promise<UserRow[]> {
    if (!ids.length) return [];
    return this.handle
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('id', 'in', ids)
      .execute();
  }

  /**
   * Lấy user theo username duy nhất.
   */
  async getByUsername(username: string): Promise<UserRow | undefined> {
    return this.handle
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('username', '=', username)
      .executeTakeFirst();
  }

  /**
   * Lấy user theo email.
   */
  async getByEmail(email: string): Promise<UserRow | undefined> {
    return this.handle
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where('email', '=', email)
      .executeTakeFirst();
  }

  /**
   * Tìm user theo từ khoá (username/email/họ tên) có phân trang — phục vụ trang quản trị.
   * Lọc trạng thái suy ra từ hai cờ của tài khoản: không truyền `status` thì chỉ lấy
   * tài khoản chưa xoá (hành vi vốn có); `active` thêm điều kiện không bị đình chỉ;
   * `suspended` lấy tài khoản chưa xoá đang bị đình chỉ; `deleted` lấy tài khoản đã
   * xoá mềm. Sắp xếp theo hợp đồng đóng ở tầng contracts: không có `sortBy` thì giữ
   * thứ tự theo id; có `sortBy` thì sắp theo trường đó (`name` là firstName rồi
   * lastName) với chiều `sortDirection` (mặc định tăng dần) và luôn neo id tăng
   * dần ở cuối để thứ tự ổn định giữa các trang.
   *
   * Điều kiện động dựng theo mẫu T-13: mọi điều kiện đều là biểu
   * thức có giá trị bắt buộc, hợp bằng `eb.and(conds)`; nhóm OR của
   * từ khoá là một biểu thức con trong cùng danh sách. Không bao
   * giờ truyền `undefined` vào `where` (nó bị gắn thành NULL và
   * lặng lẽ trả 0 dòng).
   */
  async search(search: string | undefined, page: number, pageSize: number, filter: UserListFilter = {}): Promise<{ rows: UserRow[]; total: number }> {
    const direction = filter.sortDirection === 'desc' ? 'desc' : 'asc';
    const applyConditions = (eb: ExpressionBuilder<CentreDB, 'users'>) => {
      const conds = [eb('deleted', '=', filter.status === 'deleted')];
      if (filter.status === 'active') conds.push(eb('suspended', '=', false));
      if (filter.status === 'suspended') conds.push(eb('suspended', '=', true));
      if (search) {
        const pattern = `%${search}%`;
        conds.push(eb.or([
          eb('username', 'ilike', pattern),
          eb('email', 'ilike', pattern),
          eb('first_name', 'ilike', pattern),
          eb('last_name', 'ilike', pattern),
        ]));
      }
      return eb.and(conds);
    };
    let rowsQuery = this.handle
      .selectFrom('users')
      .select(USER_COLUMNS)
      .where((eb) => applyConditions(eb));
    rowsQuery = filter.sortBy === 'name'
      ? rowsQuery.orderBy('first_name', direction).orderBy('last_name', direction).orderBy('id', 'asc')
      : filter.sortBy === 'createdAt'
        ? rowsQuery.orderBy('created_at', direction).orderBy('id', 'asc')
        : filter.sortBy === 'lastLogin'
          ? rowsQuery.orderBy('last_login', direction).orderBy('id', 'asc')
          : rowsQuery.orderBy('id', 'asc');
    const rows = await rowsQuery.limit(pageSize).offset((page - 1) * pageSize).execute();
    const count = await this.handle
      .selectFrom('users')
      .select(sql<number>`count(*)::int`.as('n'))
      .where((eb) => applyConditions(eb))
      .executeTakeFirst();
    return { rows, total: count?.n ?? 0 };
  }

  /**
   * Ghi tuỳ chọn cá nhân của user (upsert theo tên).
   */
  async setPreference(userId: string, name: string, value: string | null): Promise<void> {
    await this.handle
      .insertInto('user_preferences')
      .values({ user_id: userId, name, value })
      .onConflict((oc) => oc.columns(['user_id', 'name']).doUpdateSet({ value }))
      .execute();
  }

  /**
   * Đọc một tuỳ chọn cá nhân; undefined nếu chưa đặt.
   */
  async getPreference(userId: string, name: string): Promise<string | null | undefined> {
    const row = await this.handle
      .selectFrom('user_preferences')
      .select(['value'])
      .where('user_id', '=', userId)
      .where('name', '=', name)
      .executeTakeFirst();
    return row?.value;
  }
}
