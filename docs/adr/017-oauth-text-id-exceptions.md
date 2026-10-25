# ADR-017: Ngoại lệ định danh TEXT cho hai bảng OAuth của Better Auth

## Trạng thái
Accepted (25/10/2026). Bổ sung cho ADR-013 (khoá chính UUIDv7). Nguồn
thiết kế: issue #163 (lát MCP-1) + hồ sơ `mcp-question-input-research`
Phần 2.2 và addendum `mcp-as-better-auth-addendum` (máy chủ OAuth bằng
plugin chính chủ của Better Auth), kiểm chứng bằng spike trên bộ
`@better-auth/mcp`/`@better-auth/oauth-provider` 1.7.12.

## Bối cảnh
Lát MCP-1 dựng máy chủ uỷ quyền (AS) cho MCP bằng bộ plugin chính chủ
`@better-auth/mcp` + `@better-auth/cimd`, ghim exact 1.7.12 lockstep
với better-auth đang dùng (ADR-012). Bộ plugin mang theo 8 bảng vật
lý: `jwks`, `oauth_client`, `oauth_resource`, `oauth_client_resource`,
`oauth_access_token`, `oauth_refresh_token`, `oauth_consent`,
`oauth_client_assertion`. Sáu bảng giữ đúng khuôn ADR-013 (`uuid` +
`DEFAULT uuidv7()`). Hai bảng dưới đây KHÔNG THỂ theo khuôn đó vì
định danh của chúng do giao thức OAuth ấn định, không do hệ thống tự
sinh.

## Quyết định
Cho phép đúng HAI cột khoá chính dạng `text`, không có default phía
DB, là ngoại lệ tường minh của ADR-013:

1. **`oauth_client.id`** — khoá chính NỘI BỘ của dòng client, dạng
   `text`, do Better Auth tự sinh lúc ghi (DB không sinh, không
   default). Bảng mang thêm một cột **`client_id`** `text` riêng
   (unique, not null) chứa định danh CÔNG KHAI của client: chuỗi
   dạng UUID với client đăng ký động (DCR), và — bản chất của CIMD
   (Client ID Metadata Document, hồ sơ MCP 2026-07-28) — chính URL
   của tài liệu metadata với client hiện đại; một URL không bao giờ
   vừa cột `uuid`. (Đính chính 25/10/2026 lúc nối lại MCP-1: bản đầu
   của ADR này gộp field `clientId` thẳng xuống cột `id` theo một
   câu trong tài liệu plugin — kiểm chứng chạy thật cho thấy schema
   check của `@better-auth/drizzle-adapter` 1.7.12 nội quan schema
   Drizzle THEO TÊN PROPERTY và luôn đòi property `id` riêng, còn
   generator chính chủ luôn phát hai cột `id` + `client_id`; bản gộp
   làm app bật cờ AS chết `SCHEMA_MISMATCH oauthClient.id` ngay khi
   khởi động, bằng chứng ở e2e `mcp-as-oauth`. Ngoại lệ TEXT vì thế
   giữ cho cột `id`, và cột `client_id` là hệ quả vật lý của model
   plugin — không phải ngoại lệ định danh thêm.)
2. **`oauth_client_assertion.id`** — bảng chống phát lại cho `jti` của
   client assertion (`private_key_jwt`): provider tự cấp id bằng hàm
   băm xác định (SHA-256 trên `(jti, client_id)`, mã hoá base64url —
   kiểm chứng trong dist của `@better-auth/oauth-provider` 1.7.12) và
   ghi với cờ cho phép id tường minh. DB không sinh, không default;
   giá trị quyết định bởi cặp (jti, client) để lần phát lại thứ hai
   va khoá chính và bị chặn ở tầng lưu trữ.

## Ràng buộc đi kèm
- Allowlist của ngoại lệ này được GHIM TƯỜNG MINH trong spec
  `apps/api/test/uuidv7-primary-keys-flow.e2e-spec.ts`: đúng hai tên
  bảng trên; mọi bảng khác có cột `id` đều phải `DEFAULT uuidv7()`.
  Thêm ngoại lệ mới phải sửa ADR này trước, không sửa spec lặng lẽ.
- Ngoại lệ chỉ áp cho hai bảng thuộc bộ plugin OAuth. Mọi bảng nghiệp
  vụ của LMS — kể cả các bảng của chính lát MCP (`mcp_idempotency_keys`
  từ MCP-0) — vẫn theo ADR-013 không ngoại lệ.
- Các cột FK trỏ tới `oauth_client.client_id` (cột `client_id` ở
  các bảng `oauth_*` — giá trị plugin ghi là định danh công khai)
  là `text` theo đúng cột đích; đây là hệ quả của quyết
  định, không phải ngoại lệ thêm.
