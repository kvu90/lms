# Image triển khai Heroku (Container Registry & Runtime): một image nền
# chứa toàn bộ monorepo đã build, ba target cuối chỉ khác lệnh chạy —
# web (API + giao diện tĩnh), worker (BullMQ) và release (migrate + seed
# dữ liệu review, chạy một lần trước mỗi bản phát hành).
FROM node:24-bookworm-slim AS base
# Một số môi trường build đi ra Internet qua proxy có CA riêng (chèn
# TLS): truyền đường dẫn CA qua build-arg NODE_EXTRA_CA_CERTS (file được
# mount vào lúc build) để npm/pnpm kiểm chứng được. Môi trường build
# thường (kể cả Heroku) không cần và để trống.
ARG NODE_EXTRA_CA_CERTS
ENV NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS
# Cài pnpm bằng npm thay vì corepack: corepack tải pnpm bằng https
# trực tiếp và không đi qua proxy của môi trường build, trong khi npm
# tôn trọng HTTPS_PROXY. Phiên bản khớp trường packageManager ở
# package.json gốc — đổi phiên bản thì sửa cả hai chỗ.
RUN npm install -g pnpm@12.14.0
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
# Không cài thêm gói hệ thống nào: image slim không có sẵn CA store cho
# apt, còn curl (Heroku khuyến nghị để stream log release phase) không
# bắt buộc — thiếu nó log release vẫn đọc được qua log của app. Xoá
# biến NODE_EXTRA_CA_CERTS khỏi image chạy thật để không trỏ tới file
# CA chỉ tồn tại ở môi trường build.
ENV NODE_EXTRA_CA_CERTS=
COPY --from=build /app /app
ENV NODE_ENV=production

FROM runtime AS web
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM runtime AS release
# Chạy thẳng bin của drizzle-kit thay vì qua pnpm: image chạy thật không
# cần tải lại pnpm qua corepack. Migrate đọc drizzle.config.ts tại
# apps/api, seed chạy bản đã build của review-seed.
CMD ["sh", "-c", "cd /app/apps/api && ./node_modules/.bin/drizzle-kit migrate && node dist/review-seed.js"]
