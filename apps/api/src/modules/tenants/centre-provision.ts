/**
 * Hàm thuần của pipeline cấp phát trung tâm mới (issue #583) — suy
 * ra tên database, tên role, tên biến môi trường bí mật, mật khẩu
 * và token lời mời từ slug của trung tâm, không chạm vào database
 * hay mạng nào nên kiểm chứng được bằng unit spec thuần.
 *
 * Mọi suy ra đều XÁC ĐỊNH theo slug: chạy lại lệnh cấp phát với
 * cùng một slug luôn cho ra cùng một tên database/role/biến môi
 * trường — đó là nền của tính idempotent của pipeline (bước nào đã
 * làm thì lần chạy lại nhận ra và bỏ qua, không tạo trùng).
 *
 * Giới hạn kỹ thuật chi phối các hàm dưới đây:
 * - Slug là một nhãn DNS (xem `SPACE_LABEL_PATTERN` ở tầng định
 *   tuyến): chỉ chữ thường, số và dấu gạch ngang, tối đa 63 ký tự.
 * - Tên database và tên role của PostgreSQL tối đa 63 BYTE; slug
 *   chỉ chứa ký tự ASCII nên số ký tự bằng số byte.
 * - Mật khẩu chèn vào URL kết nối `postgres://` phải an toàn với
 *   URI (bài học từ sự cố biến môi trường của preview: mật khẩu
 *   chứa ký tự phá URI làm bước migrate lỗi `URI malformed`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { SPACE_LABEL_PATTERN } from './space-resolution';

/** Tiền tố tên database riêng của một trung tâm trên cụm chung. */
export const CENTRE_DATABASE_PREFIX = 'lms_space_';
/** Tiền tố tên role kết nối của một trung tâm (khác tiền tố database để không lẫn). */
export const CENTRE_ROLE_PREFIX = 'lms_role_';
/** Giới hạn độ dài định danh của PostgreSQL (byte; slug ASCII nên bằng số ký tự). */
export const POSTGRES_IDENTIFIER_LIMIT = 63;
/** Hạn dùng của lời mời kích hoạt: 7 ngày kể từ lúc cấp. */
export const CENTRE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Mã gói dữ liệu chương trình (YCCĐ) được cài cục bộ vào kho trung tâm khi cấp phát. */
export const CENTRE_PROGRAM_PACKAGE_KEY = 'gdpt-2018';

/**
 * Shim `uuidv7()` cho cụm PostgreSQL dưới 18 (cùng công thức với
 * shim của spec fleet — môi trường kiểm thử và cụm cũ chưa có hàm
 * gốc): CHỈ áp khi phiên bản máy chủ < 18; trên 18 tuyệt đối không
 * áp vì sẽ che mất hàm gốc. Cần `pgcrypto` (extension trusted từ
 * PG13 nên chủ sở hữu database tự tạo được). Baseline nghiệp vụ
 * dùng `uuidv7()` làm giá trị mặc định nên mọi bước tạo đối tượng
 * trên cụm dưới 18 đều cần shim này trước — pipeline cấp phát và
 * bước ensure delta schema dùng chung một hằng số để không lệch
 * công thức.
 */
export const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/**
 * Chuẩn hoá slug đầu vào của lệnh cấp phát: xén khoảng trắng hai
 * đầu, hạ về chữ thường (tên miền không phân biệt hoa thường) rồi
 * kiểm tra đúng hình dạng nhãn DNS của tầng định tuyến. Slug không
 * đúng hình dạng bị từ chối ngay trước khi chạm vào bất kỳ đối
 * tượng nào — một slug mà tầng định tuyến không trích được thì
 * trung tâm đó không bao giờ phục vụ được.
 *
 * @param raw - Slug thô từ dòng lệnh.
 * @returns Slug đã chuẩn hoá.
 * @throws Error khi slug rỗng hoặc sai hình dạng.
 */
export function normalizeSpaceSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!SPACE_LABEL_PATTERN.test(slug)) {
    throw new Error(
      `Invalid space slug "${raw}": expected a DNS label (lowercase letters, digits, hyphens, at most 63 characters)`,
    );
  }
  return slug;
}

/**
 * Suy ra tên database của trung tâm từ slug: tiền tố + slug đã đổi
 * dấu gạch ngang thành gạch dưới (tên database dùng gạch dưới cho
 * dễ đọc trong câu lệnh SQL). Slug dài tới mức vượt giới hạn 63 ký
 * tự thì cắt ngắn và gắn 8 ký tự đầu của băm SHA-256 của slug —
 * vẫn xác định theo slug, và hai slug khác nhau không bao giờ cho
 * ra cùng một tên do hậu tố băm (trùng tên còn lại — nếu có — bị
 * kiểm tra trùng databaseName của pipeline chặn lại trước khi ghi).
 *
 * @param slug - Slug đã chuẩn hoá.
 * @returns Tên database (tối đa 63 ký tự).
 */
export function deriveCentreDatabaseName(slug: string): string {
  return derivePostgresIdentifier(CENTRE_DATABASE_PREFIX, slug);
}

/**
 * Suy ra tên role kết nối của trung tâm từ slug, cùng cơ chế cắt
 * ngắn + hậu tố băm như tên database nhưng với tiền tố riêng để
 * role không bao giờ trùng tên database (hai không gian tên khác
 * nhau của PostgreSQL nhưng giữ phân biệt cho dễ vận hành).
 *
 * @param slug - Slug đã chuẩn hoá.
 * @returns Tên role (tối đa 63 ký tự).
 */
export function deriveCentreRoleName(slug: string): string {
  return derivePostgresIdentifier(CENTRE_ROLE_PREFIX, slug);
}

/**
 * Suy ra tên biến môi trường giữ URL kết nối của trung tâm từ slug:
 * `SPACE_<SLUG_SNAKE>_DATABASE_URL` (slug viết hoa, gạch ngang thành
 * gạch dưới). Sổ đăng ký chỉ giữ đúng tham chiếu này (`secretRef`),
 * không giữ giá trị URL — vận hành thêm biến vào môi trường triển
 * khai thì tầng ứng dụng mới phân giải được trung tâm mới.
 *
 * @param slug - Slug đã chuẩn hoá.
 * @returns Tên biến môi trường (ví dụ `SPACE_TRUNG_TAM_A_DATABASE_URL`).
 */
export function deriveCentreSecretEnvVar(slug: string): string {
  return `SPACE_${slug.toUpperCase().replaceAll('-', '_')}_DATABASE_URL`;
}

/**
 * Sinh mật khẩu cho role kết nối của trung tâm: 24 ký tự chỉ gồm
 * chữ và số nên an toàn tuyệt đối khi chèn vào URL kết nối
 * `postgres://` (không cần mã hoá phần trăm, không phá URI).
 * Mật khẩu này chỉ in ra đúng một lần ở đầu ra của lệnh cấp phát
 * và không bao giờ được ghi xuống đĩa hay vào sổ đăng ký.
 *
 * @returns Mật khẩu 24 ký tự chữ-số.
 */
export function generateCentreDatabasePassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(24);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * Sinh token lời mời kích hoạt: 32 byte ngẫu nhiên mã hoá base64url
 * (256 bit — không thể đoán hay liệt kê). Token gốc chỉ xuất hiện
 * ở đầu ra của lệnh cấp phát/cấp lại; trong database chỉ lưu băm
 * SHA-256 của nó.
 *
 * @returns Token lời mời dạng base64url.
 */
export function generateCentreInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Băm token lời mời bằng SHA-256 (hex) để lưu và tra cứu: tra cứu
 * theo băm nên kẻ đọc được database cũng không khôi phục được
 * token gốc để kích hoạt trái phép.
 *
 * @param token - Token lời mời gốc.
 * @returns Băm SHA-256 dạng hex.
 */
export function hashCentreInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Dựng URL kết nối tới database của trung tâm từ các thành phần:
 * mật khẩu được mã hoá phần trăm (dù mật khẩu do CLI sinh đã an
 * toàn với URI, mật khẩu do vận hành cấp qua biến môi trường có
 * thể chứa ký tự đặc biệt — mã hoá ở đây chặn lỗi `URI malformed`
 * ở mọi đường dùng URL này).
 *
 * @param parts - host, cổng, role, mật khẩu, tên database.
 * @returns URL kết nối `postgres://`.
 */
export function buildCentreDatabaseUrl(parts: {
  host: string;
  port: number;
  role: string;
  password: string;
  databaseName: string;
}): string {
  return `postgres://${parts.role}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${parts.databaseName}`;
}

/**
 * Suy ra định danh PostgreSQL từ tiền tố + slug: đổi gạch ngang
 * thành gạch dưới, giữ nguyên khi vừa giới hạn, cắt ngắn + gắn hậu
 * tố băm khi vượt giới hạn.
 */
function derivePostgresIdentifier(prefix: string, slug: string): string {
  const body = slug.replaceAll('-', '_');
  const full = `${prefix}${body}`;
  if (full.length <= POSTGRES_IDENTIFIER_LIMIT) return full;
  // Chừa đúng một ký tự gạch dưới + 8 ký tự băm trong giới hạn.
  const keep = POSTGRES_IDENTIFIER_LIMIT - prefix.length - 9;
  const hash = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${prefix}${body.slice(0, keep)}_${hash}`;
}
