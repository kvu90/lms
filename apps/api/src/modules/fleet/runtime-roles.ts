/**
 * Helper THUẦN cho việc cấp phát ROLE RUNTIME và ROLE MIGRATION của
 * kho nghiệp vụ (issue #586): tách phần suy luận (đọc đích từ URL,
 * dựng câu SQL) khỏi phần thực thi (script `runtime-roles-setup.ts`)
 * để kiểm chứng bằng unit test không cần database thật — cùng khuôn
 * với `control-plane-provision.ts` của issue #580.
 *
 * Mô hình role của một kho (áp cho kho nghiệp vụ hiện tại và là
 * khuôn cho mọi kho riêng của trung tâm về sau):
 * - Role MIGRATION: role duy nhất được sở hữu database và mọi đối
 *   tượng trong đó; chỉ các bước áp migration (drizzle-kit, runner
 *   migration của đội kho) dùng role này. Mọi thay đổi schema vì vậy
 *   đi qua đúng một danh tính có ghi nhận, không lẫn với đường đọc
 *   ghi thường ngày.
 * - Role RUNTIME: role của tầng ứng dụng (api + worker) — KHÔNG
 *   phải superuser, không sở hữu bất kỳ đối tượng nào, chỉ giữ
 *   quyền dữ liệu tối thiểu (đọc/ghi dòng và dùng sequence trên
 *   schema nghiệp vụ). Cô lập kết nối giữa các database (control
 *   plane, kho trung tâm) chỉ đứng vững khi role kết nối không phải
 *   superuser: superuser bỏ qua mọi kiểm tra quyền CONNECT, nên
 *   runtime là superuser (trạng thái trước issue này, khi
 *   `DATABASE_URL` dùng chính tài khoản quản trị của image
 *   Postgres) thì thu hồi CONNECT không còn tác dụng.
 * - Role quản trị của cụm (tài khoản chính của image Postgres) chỉ
 *   còn vai trò bootstrap: tạo role/database ở bước cấp phát rồi
 *   rút khỏi mọi đường dữ kiện thường ngày.
 *
 * Hai URL `MIGRATION_DATABASE_URL` và `RUNTIME_DATABASE_URL` là
 * nguồn sự thật duy nhất về đích cấp phát: tên database = path,
 * role = username, mật khẩu = password của từng URL — script không
 * nhận tham số nào khác, nối tiếp đúng cách `control-plane-setup`
 * đọc `CONTROL_PLANE_DATABASE_URL`.
 */
import { quoteIdentifier, quoteLiteral } from '../control-plane/control-plane-provision';

/** Đích cấp phát của một role, suy ra từ URL kết nối của role đó. */
export type RoleEndpoint = {
  /** Tên database mà role thuộc về (path của URL). */
  database: string;
  /** Tên role (username của URL). */
  role: string;
  /** Mật khẩu của role (chỉ dùng khi dựng câu lệnh, không bao giờ ghi log). */
  rolePassword: string;
};

/**
 * Đọc đích cấp phát của một role từ URL kết nối của nó.
 * @param url - URL kết nối mang role ở username và database ở path.
 * @param envName - Tên biến môi trường mang URL (chỉ để câu lỗi gọi đúng tên cấu hình sai).
 * @throws Error khi URL thiếu tên database hoặc thiếu username — cấu
 * hình sai phải lộ ngay ở bước cấp phát, không chạy tiếp nửa vời.
 */
export function parseRoleEndpoint(url: string, envName: string): RoleEndpoint {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const role = decodeURIComponent(parsed.username);
  if (!database) throw new Error(`${envName} must name a database in its path`);
  if (!role) throw new Error(`${envName} must carry the connection role as username`);
  return { database, role, rolePassword: decodeURIComponent(parsed.password) };
}

/**
 * Các câu lệnh đảm bảo một role tồn tại với tư thế quyền ĐÚNG khuôn
 * tối thiểu: đăng nhập được, KHÔNG superuser, không tạo database,
 * không tạo role, không replication, không bỏ qua RLS. Chưa có thì
 * tạo, đã có thì đồng bộ lại cả mật khẩu lẫn tư thế quyền (một role
 * từng được tạo tay với quyền cao hơn sẽ bị hạ về đúng khuôn ở mỗi
 * lượt cấp phát). Chạy lặp an toàn.
 */
export function buildEnsureRoleStatements(endpoint: RoleEndpoint, roleExists: boolean): string[] {
  const role = quoteIdentifier(endpoint.role);
  const rolePasswordLiteral = quoteLiteral(endpoint.rolePassword);
  const posture = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  if (!roleExists) {
    return [`CREATE ROLE ${role} WITH ${posture} PASSWORD ${rolePasswordLiteral}`];
  }
  return [`ALTER ROLE ${role} WITH ${posture} PASSWORD ${rolePasswordLiteral}`];
}

/**
 * Câu lệnh chuyển quyền sở hữu DATABASE sang role migration. Sở
 * hữu database là điều kiện để role migration sở hữu tiếp các đối
 * tượng sinh ra trong đó (schema `public` thuộc về chủ database
 * theo cơ chế `pg_database_owner` của PostgreSQL 15+) và là mốc để
 * bước chuyển quyền sở hữu từng đối tượng (xem
 * `buildOwnershipTransferQuery`) có đích rõ ràng.
 */
export function buildTransferDatabaseOwnerStatement(endpoint: RoleEndpoint): string {
  return `ALTER DATABASE ${quoteIdentifier(endpoint.database)} OWNER TO ${quoteIdentifier(endpoint.role)}`;
}

/**
 * Câu truy vấn liệt kê các câu lệnh chuyển quyền sở hữu TỪNG đối
 * tượng của `fromRole` trong database hiện hành sang role
 * migration: bảng/view/bảng vật hoá/sequence, hàm, kiểu enum/domain
 * và schema — chỉ trong các schema người dùng (loại `pg_catalog`,
 * `information_schema` và các schema hệ thống tạm/toast).
 *
 * Vì sao không dùng `REASSIGN OWNED`: lệnh đó bị PostgreSQL từ
 * chối hẳn khi role nguồn là superuser gốc của cụm (bootstrap
 * superuser) vì role đó sở hữu các đối tượng "hệ thống bắt buộc"
 * trong MỌI database (điển hình là các view của
 * `information_schema`) — mà role nguồn ở các kho đã tồn tại trước
 * mô hình role mới luôn chính là superuser gốc đó (migration trước
 * đây chạy bằng tài khoản quản trị của image). Liệt kê theo lớp
 * đối tượng là đường chuyển chủ duy nhất chạy được cho trường hợp
 * này; index đi theo bảng chủ của chúng, kiểu composite đi theo
 * bảng, và schema `public` thuộc `pg_database_owner` nên tự theo
 * chủ database mới.
 *
 * Ngoại lệ bắt buộc trong lớp quan hệ: sequence GẮN VỚI CỘT của
 * một bảng (cột serial — phụ thuộc pg_depend deptype 'a'; cột
 * identity — deptype 'i') KHÔNG được liệt kê riêng, vì PostgreSQL
 * từ chối đổi chủ riêng cho sequence dạng này ở cả hai động từ
 * ALTER TABLE và ALTER SEQUENCE ("cannot change owner of
 * sequence", kèm DETAIL sequence linked to table). Chủ của sequence
 * dạng này đổi theo bảng chủ của nó, nên chỉ cần chuyển bảng là
 * đủ; sequence rời (CREATE SEQUENCE, không gắn cột) vẫn được liệt
 * kê và chuyển trực tiếp như cũ.
 */
export function buildOwnershipTransferQuery(fromRole: string, toRole: string): string {
  const from = quoteLiteral(fromRole);
  const to = quoteLiteral(toRole);
  const ownerPredicate = (column: string) => `${column} = (SELECT oid FROM pg_roles WHERE rolname = ${from})`;
  return [
    `SELECT format('ALTER TABLE %I.%I OWNER TO %I', ns.nspname, c.relname, ${to}) AS statement`,
    `FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace`,
    `WHERE ${ownerPredicate('c.relowner')} AND c.relkind IN ('r', 'p', 'm', 'v', 'S')`,
    `AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.refobjsubid <> 0 AND d.deptype IN ('a', 'i')))`,
    `UNION ALL`,
    `SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I', ns.nspname, p.proname, pg_get_function_identity_arguments(p.oid), ${to})`,
    `FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace`,
    `WHERE ${ownerPredicate('p.proowner')} AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `UNION ALL`,
    `SELECT format('ALTER TYPE %I.%I OWNER TO %I', ns.nspname, t.typname, ${to})`,
    `FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace`,
    `WHERE ${ownerPredicate('t.typowner')} AND t.typtype IN ('e', 'd')`,
    `AND ns.nspname NOT IN ('pg_catalog', 'information_schema')`,
    `UNION ALL`,
    `SELECT format('ALTER SCHEMA %I OWNER TO %I', ns.nspname, ${to})`,
    `FROM pg_namespace ns`,
    `WHERE ${ownerPredicate('ns.nspowner')} AND ns.nspname NOT IN ('pg_catalog', 'information_schema', 'public')`,
    `AND ns.nspname NOT LIKE 'pg_toast%' AND ns.nspname NOT LIKE 'pg_temp%'`,
  ].join(' ');
}

/**
 * Các câu lệnh khoá quyền kết nối của database nghiệp vụ ở mức cụm
 * (chạy trên kết nối quản trị): thu hồi quyền kết nối mặc định của
 * PUBLIC, chỉ cấp tường minh cho role migration và role runtime —
 * mọi role khác (gồm role của control plane và các kho khác) bị từ
 * chối ngay ở bước mở kết nối. Cùng nửa cô lập với
 * `buildRestrictBusinessConnectStatements` của control plane
 * (script đó cấp cho role suy từ `DATABASE_URL` của bước migrate;
 * bước này cấp đủ cả hai role của mô hình mới) — cả hai đều chỉ thu
 * hồi PUBLIC và cấp tường minh, không thu hồi chéo của nhau.
 */
export function buildRoleConnectStatements(database: string, migratorRole: string, runtimeRole: string): string[] {
  const db = quoteIdentifier(database);
  return [
    `REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO ${quoteIdentifier(migratorRole)}`,
    `GRANT CONNECT ON DATABASE ${db} TO ${quoteIdentifier(runtimeRole)}`,
  ];
}

/**
 * Các câu lệnh cấp quyền dữ liệu tối thiểu cho role runtime, chạy
 * BÊN TRONG database nghiệp vụ sau khi quyền sở hữu đã thuộc role
 * migration:
 * - Quyền dùng schema `public` (không gồm quyền tạo đối tượng —
 *   runtime không được tạo bảng/cột, đó là việc của migration).
 * - Quyền đọc/ghi dòng trên MỌI bảng hiện có và quyền dùng sequence
 *   (cột identity/serial cần sequence ở mỗi lần ghi).
 * - Quyền mặc định gắn với CHÍNH role migration: mọi bảng/sequence
 *   do migration tạo về sau tự động mang theo đúng bộ quyền này cho
 *   runtime, nên bước áp migration không cần bước cấp quyền riêng.
 * - Quyền dùng các kiểu enum hiện có trong schema (câu lệnh GRANT
 *   không có dạng "mọi kiểu trong schema" nên dùng khối DO lặp qua
 *   danh mục kiểu): truy vấn có ép kiểu tường minh lên cột enum cần
 *   quyền này, thiếu là lỗi quyền khó hiểu ở đường dữ kiện.
 * - Quyền mặc định trên KIỂU cho chính role migration (hạng mục
 *   cứng hoá tuỳ chọn theo phân xử trên PR của issue này): kiểu
 *   enum do migration tạo về sau tự mang quyền USAGE cho runtime,
 *   thay vì phụ thuộc vào mặc định của PostgreSQL là cấp USAGE
 *   trên kiểu mới cho PUBLIC — mặc định đó bị thu hồi thì runtime
 *   vẫn dùng được kiểu của migration mới.
 */
export function buildRuntimeGrantStatements(migratorRole: string, runtimeRole: string): string[] {
  const runtime = quoteIdentifier(runtimeRole);
  const migrator = quoteIdentifier(migratorRole);
  return [
    `GRANT USAGE ON SCHEMA public TO ${runtime}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${runtime}`,
    `DO $$ DECLARE t record; BEGIN FOR t IN SELECT n.nspname AS schema_name, p.typname AS type_name FROM pg_type p JOIN pg_namespace n ON n.oid = p.typnamespace WHERE p.typcategory = 'E' AND n.nspname = 'public' LOOP EXECUTE format('GRANT USAGE ON TYPE %I.%I TO %I', t.schema_name, t.type_name, ${quoteLiteral(runtimeRole)}); END LOOP; END $$;`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT USAGE ON TYPES TO ${runtime}`,
  ];
}
