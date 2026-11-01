# @lms/db — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`packages/db` là **định nghĩa dữ liệu dùng chung duy nhất** của hệ thống: toàn bộ
bảng của mọi miền nghiệp vụ (access, courses, questions, quiz, grades, messaging,
payments, tenants, books, curriculum…) khai ở đây, để `apps/api` và `apps/worker`
đọc/ghi trên **cùng một mô hình dữ liệu** — không còn bản sao schema riêng theo
từng app (việc hợp nhất này là lý do package tồn tại). Hình dạng bảng ở đây quyết
định những sự thật nghiệp vụ nào được lưu bền: trạng thái công bố điểm, quan hệ
lớp–khoá, tenant của mọi bản ghi, vết audit.

Hệ đang trong chiến dịch chuyển tầng dữ liệu từ Drizzle sang **Kysely**: package
này giữ khung Kysely (kiểu sinh từ DB thật, factory dựng instance, harness test)
và — theo từng hạng mục chuyển đổi — các repository Kysely trong
`src/repositories/`; phần chưa chuyển vẫn chạy bằng schema Drizzle trong cùng
package. Hai ORM cùng tồn tại trong giai đoạn chuyển đổi theo quy ước ở mục
"Quy ước hai ORM cùng tồn tại" dưới đây; đích cuối của chiến dịch là gỡ hẳn
Drizzle khỏi cây mã.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Multi-tenant bằng shared DB: mọi bảng nghiệp vụ mang `tenant_id` và được PostgreSQL **RLS ép fail-closed** (policy theo GUC `app.tenant_id`; thiếu ngữ cảnh tenant = không thấy dữ liệu). Tenant = TRUNG TÂM; trang chính là tenant nền tảng. | Sổ mục A; issue #166, TENANT-0 |
| Khoá chính mặc định **UUIDv7** cho các bảng nghiệp vụ (trừ ngoại lệ đã chốt, vd bảng OAuth của Better Auth). Số lượng bảng/số mặc định uuidv7/số policy RLS là bất biến được spec ở apps/api khoá cứng — thay đổi schema phải cập nhật các đếm đó bằng con số đếm thật trên baseline cuối. | Nền uuidv7 toàn hệ; spec `uuidv7-primary-keys-flow` |
| Lớp–khoá: một khoá thuộc đúng một lớp (`course.class_id`); roster lớp nằm ở cohort đi kèm lớp (không bảng roster riêng) — schema phải giữ quan hệ này, không tạo đường ghi danh song song thứ hai. | Sổ mục A; issue #184 |
| Dữ liệu chuẩn GDPT neo bằng UUIDv5 theo khoá tự nhiên; 4 FK từ dữ liệu chuẩn dùng `restrict` (không cascade) để import diff không xoá được dữ liệu đã neo. | Phương án D, chốt 25/10/2026; issue #161 |
| Dự án xây từ đầu: **reset dữ liệu thoải mái tới khi chốt version** — schema tiến hoá bằng baseline mới, không thiết kế migration giữ dữ liệu live. | Sổ mục F, chốt 23/10/2026 |
| Hai dòng tiền tách bạch trong schema thanh toán: bản ghi thanh toán gắn tenant sở hữu và tài khoản nhận của chính chủ sở hữu; platform không thu hộ học phí trung tâm. | Sổ mục E; issue #189 |

## Khung Kysely

### Kiểu sinh từ DB thật (codegen)

- Ba file kiểu của ba kho — `src/types/centre-db.d.ts`,
  `src/types/control-plane-db.d.ts`, `src/types/system-bank-db.d.ts` — được
  **kysely-codegen sinh từ cơ sở dữ liệu thật**, không viết tay và không sửa
  tay. Lệnh `pnpm --filter @lms/db db:types` dựng ba database từ rỗng bằng
  đúng bộ SQL đang mang dữ liệu hiện hành (script `scripts/generate-types.mjs`),
  rồi chạy codegen cho từng kho. CI (job `verify`) chạy lại lệnh này và yêu
  cầu `git diff` trên `src/types/` rỗng — file kiểu lệch khỏi DB thật là CI đỏ.
- Kết nối quản trị cho `db:types` lấy từ biến môi trường
  `DB_TYPES_ADMIN_URL`, hoặc suy từ `DATABASE_URL` (thay tên database thành
  `postgres`). Cụm dưới PostgreSQL 18 được cài shim `uuidv7()` viết tay trước
  khi áp SQL (PG18 có hàm tích hợp); shim nằm ngoài nội dung SQL mang dữ liệu.
- **Không camelCase ở bất kỳ tầng nào**: không bật `--camel-case` của codegen,
  không dùng `CamelCasePlugin` — tên bảng/cột trong kiểu giữ đúng snake_case
  của DB (`row.tenant_id`), một nguồn sự thật duy nhất là DB thật.
- Ánh xạ kiểu mặc định của codegen được giữ nguyên: `uuid` → `string`,
  `timestamptz` → `ColumnType<Date, …>`, `numeric` → `string` (hiện repo chưa
  có cột numeric nào — đây là kỷ luật phòng ngừa cho cột đầu tiên xuất hiện).
- **Cột có giá trị mặc định** được codegen bọc trong `Generated<…>`: cổng đếm
  theo kho trên cụm PG18 thật — số cột `id` có mặc định `uuidv7()` là
  **trung tâm 187, control plane 5, ngân hàng hệ thống 10** (đếm trên
  catalog của DB dựng từ rỗng; riêng `oauth_client.id` mang mặc định
  `gen_random_uuid()` nên số `id: Generated<string>` trong file sinh của kho
  trung tâm là 188).
- **Cột jsonb có hình dạng nghiệp vụ thật** (phía Drizzle đang khai bằng
  `$type<…>()`) phải có override từng cột trong file cấu hình codegen của
  kho (`scripts/codegen/<kho>.json`, khoá `overrides.columns` theo dạng
  `bảng.cột`, kèm `customImports` trỏ về nơi định nghĩa kiểu thật). Chuỗi
  override thay toàn bộ kiểu của cột nên phải tự mang `| null` khi cột
  nullable và `Generated<…>` khi cột có mặc định. Hiện có 21 cột như vậy
  (liệt kê trong chính các file cấu hình). Lưu ý `--type-mapping` của
  kysely-codegen ánh xạ theo **kiểu dữ liệu PostgreSQL** trên toàn cục —
  không dùng nó cho override từng cột.
- Sau khi đổi hình dạng DB, migration mới viết tay và `db:types` là cơ chế
  bắt lệch kiểu (không còn `db:generate` cho phần đã chuyển sang Kysely).

### Factory và kiểu handle

- `src/client.ts` khai ba factory — `createCentreKysely(pool)`,
  `createControlPlaneKysely(pool)`, `createSystemBankKysely(pool)` — dùng
  `PostgresDialect` với pool do tầng ứng dụng cấp, kèm các kiểu handle
  `CentreDb`/`CentreTx`, `ControlPlaneDb`/`ControlPlaneTx`,
  `SystemBankDb`/`SystemBankTx`. Mọi repository Kysely nhận handle qua các
  kiểu này; kiểu hàng suy bằng `Selectable`/`Insertable`/`Updateable` của
  Kysely trên interface schema (thay `$inferSelect`/`$inferInsert`).
- Vòng đời instance đi theo vòng đời pool của ứng dụng: `instance.destroy()`
  đóng luôn pool đã truyền vào.

### Luật của package đối với mã Kysely

- Package **không tự mở pool, không đọc biến môi trường** — pool luôn do
  tầng ứng dụng tạo (đã gắn ngữ cảnh tenant/GUC nếu là kho trung tâm) và
  truyền vào factory.
- Repository trong package **không import từ `apps/*`**, **không đọc ALS
  hay ngữ cảnh của app**, **không giữ kết nối riêng ngoài factory**: mọi
  truy vấn đi qua handle được truyền vào. Ngữ cảnh tenant đến từ pool
  (GUC ở tầng kết nối), không đến từ tham số của repository.
- Điểm vào test-support (`@lms/db/test-support`, thư mục
  `src/test-support/`) chỉ dùng trong test: dựng DB test từ rỗng bằng SQL
  mang dữ liệu (`buildTestDatabase`), pool test gắn ngữ cảnh tenant theo
  đúng hợp đồng GUC của hệ (`TestTenantPool`), và `createTestKysely(...)`
  bọc ba factory production cho spec.

## Quy ước hai ORM cùng tồn tại

- **Một module thuộc hẳn về một ORM**: module đã chuyển sang Kysely thì
  toàn bộ đường dữ liệu của nó đi qua handle Kysely; module chưa chuyển
  giữ nguyên Drizzle. Không trộn hai ORM trong cùng một module.
- **Cấm giao dịch lai**: một thao tác nghiệp vụ không bao giờ mở đồng
  thời một giao dịch Drizzle và một giao dịch Kysely — tính nguyên tử
  không bắc qua hai ORM được.
- Các file schema Drizzle (`src/*.schema.ts`) đóng băng trong giai đoạn
  chuyển đổi: không sửa, không xoá cho tới hạng mục gỡ Drizzle ở cuối
  chiến dịch (riêng các kiểu hình dạng jsonb mà codegen tham chiếu vẫn
  sống trong các file đó cho tới khi được dời đi ở hạng mục gỡ).

## Ranh giới — package này KHÔNG làm gì

- Không chứa logic nghiệp vụ hay gác quyền theo capability: package giữ
  định nghĩa dữ liệu và (phần đã chuyển) các hàm truy cập dữ liệu thuần
  qua handle; luật chạy nằm ở `apps/api`.
- Carrier migration hiện hành nằm ở `packages/db/migrations/<kho>`
  (centre, control-plane, system-bank) — bộ SQL đóng băng dời từ
  `apps/api/drizzle*` ở hạng mục nền thứ hai của chiến dịch (issue
  #639); bộ máy áp là Migrator của Kysely trong `src/migrate/`
  (provider đọc carrier, cấy nhật ký adoption, runner CLI
  `dist/migrate/run.js <kho>`, hậu kiểm số đếm). Nhật ký Drizzle
  cũ (`drizzle.__drizzle_migrations`) giữ nguyên, chỉ đọc trong
  cửa sổ cùng tồn tại.
- Không phải hợp đồng API: hình dạng request/response thuộc `packages/contracts`.

## Kỹ thuật tối thiểu

- Nguồn theo miền: `src/<miền>.schema.ts`, hạ tầng chung ở
  `src/infrastructure.schema.ts`, xuất qua `src/index.ts`.
- Ngoại lệ có chủ đích: schema control plane (`src/control-plane.schema.ts`,
  issue #580) thuộc **database riêng** trên cùng cụm Postgres với bộ migration
  riêng ở `packages/db/migrations/control-plane/`, nên xuất qua subpath
  `@lms/db/control-plane` (`src/control-plane.ts`) và KHÔNG qua `src/index.ts` —
  đưa vào barrel chung sẽ làm bộ migration của kho nghiệp vụ sinh lệnh cho các
  bảng control plane và ngược lại. Kho ngân hàng hệ thống theo cùng khuôn qua
  `@lms/db/system-bank`. Factory và kiểu handle của từng kho đi theo đúng các
  điểm vào này.
- Subpath repository khai bằng **một** wildcard duy nhất
  (`"./repositories/*"` trong `package.json`, một dòng `paths` wildcard
  tương ứng trong tsconfig của `apps/api` và `apps/worker`) — không khai
  thêm đường dẫn riêng cho từng module repository.
- App tiêu thụ dùng bản `dist` — sửa package xong phải build lại trước khi
  typecheck/migrate ở app (dist cũ = lỗi giả kinh điển). Build của package
  chép cả ba file kiểu sinh vào `dist/types/` (tsc không tự chép file
  `.d.ts` đầu vào).
