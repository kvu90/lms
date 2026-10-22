# ADR-014: Bảo vệ biên HTTP — header bảo mật, CORS theo cấu hình, giới hạn tốc độ hai lớp

## Trạng thái
Accepted (22/10/2026).

## Bối cảnh
Trước đợt này API chưa có header bảo mật, `enableCors()` dùng mặc định
(phản chiếu mọi origin) và không có giới hạn tốc độ theo IP — lớp bảo
vệ duy nhất cho đăng nhập là khoá tài khoản theo ngưỡng sai
(`LOCKOUT_THRESHOLD`), vốn không chặn được dò mật khẩu phân tán qua
nhiều tài khoản hay phá hoại ở các route khác.

## Quyết định
- **Header bảo mật** bằng middleware tự xây
  (`SecurityHeadersMiddleware`, cùng tinh thần tự xây như
  ProblemDetailsFilter): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS một
  năm cho mọi phản hồi; thêm CSP chặt `default-src 'none';
  frame-ancestors 'none'` riêng cho các route API JSON `/api/v1/…`
  (trang Swagger `/api/docs` cần nạp tài nguyên của chính nó).
  Middleware của Nest nhận `req.path` đã rút gọn theo route nên việc
  phân biệt path dùng `originalUrl`.
- **CORS theo cấu hình**: `enableCors` chỉ mở cho các origin liệt kê
  trong `CORS_ORIGINS` (mặc định `http://localhost:5173` cho dev),
  `credentials: true`. Production khai đúng domain của web.
- **Giới hạn tốc độ hai lớp theo IP** bằng gói chính thức
  `@nestjs/throttler` 6.7.1, `ThrottlerGuard` chạy đầu tiên trong
  chuỗi guard:
  - lớp `default`: `RATE_LIMIT_PER_MINUTE` (mặc định 3000/phút/IP) cho
    mọi route;
  - lớp `auth`: `RATE_LIMIT_AUTH_PER_MINUTE` (mặc định 300/phút/IP),
    chỉ áp cho các route POST xác thực có kiểm chứng mật khẩu
    (`auth/token`, `auth/login`, `auth/session/login`,
    `auth/change-password`) qua `skipIf` theo method + path.
  Vượt hạn mức trả 429 qua ProblemDetailsFilter như mọi lỗi khác.
- **Mặc định phải tính tới IP NAT của trường học**: hàng trăm học viên
  có thể cùng ra Internet qua một IP; siết chặt hơn mặc định này phải
  cân nhắc giờ vào lớp đồng loạt (xem runbook vận hành).

## Hệ quả và giới hạn đã biết
- Bộ đếm của throttler nằm trong bộ nhớ của tiến trình API (mặc định
  của gói): đúng cho mô hình modular monolith một instance hiện tại.
  Khi scale nhiều instance API, hạn mức theo IP sẽ nhân theo số
  instance — khi đó chuyển sang storage dùng chung (Redis) bằng
  `ThrottlerStorage` tuỳ biến; ghi nhận là việc phải làm ở thời điểm
  scale, không làm trước.
- Hạn mức là lớp bảo vệ theo IP, bổ sung — không thay thế — khoá tài
  khoản theo ngưỡng sai và kiểm quyền theo context.

## Kiểm chứng
`apps/api/test/platform-hardening.e2e-spec.ts`: header bảo mật + CSP
có mặt trên phản hồi thật; với hạn mức auth hạ xuống 3/phút, lần đăng
nhập thứ 4 trong cùng phút từ một IP nhận 429 Problem Details trong
khi các route khác vẫn 200. CORS và header cũng đã kiểm chứng trên
server thật ngoài bộ test (origin lạ không nhận
`Access-Control-Allow-Origin`).
