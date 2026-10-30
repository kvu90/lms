# Dockerfile production ở gốc repo — một giai đoạn build dùng chung cho cả
# ba ứng dụng (api, worker, web) và ba target runtime tương ứng, chọn bằng
# `--target` (docker compose đã khai sẵn theo từng service).
#
# Cách build giữ đúng cách build monorepo hiện hành: `pnpm install
# --frozen-lockfile` rồi `turbo run build` cho ba app, sau đó đóng gói
# từng app bằng `pnpm deploy --prod` (bản đóng gói tự chứa: dist/build đã
# biên dịch + node_modules chỉ còn dependency production, gồm cả các
# package workspace đã biên dịch) để các image runtime không mang theo
# mã nguồn monorepo và devDependency.
#
# Các image runtime dùng node:24-bookworm-slim cùng họ glibc với image
# build (bookworm đầy đủ) vì @lms/api có dependency native argon2 — bản
# binary biên dịch ở giai đoạn build phải nạp được ở giai đoạn runtime.

# syntax=docker/dockerfile:1

# ----- Giai đoạn build dùng chung -----
FROM node:24-bookworm AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@lms/api --filter=@lms/worker --filter=@lms/web
RUN pnpm --filter @lms/api deploy --prod /out/api \
  && pnpm --filter @lms/worker deploy --prod /out/worker \
  && pnpm --filter @lms/web deploy --prod /out/web

# ----- Runtime API -----
# Tiến trình API NestJS đã biên dịch (dist/main.js). Dữ liệu tệp tải lên
# nằm ở FILE_STORAGE_DIR (mặc định ./data/files theo cấu hình app) —
# compose.yaml gắn volume bền vào đúng thư mục này.
FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
# Bộ công cụ PostgreSQL 18 (pg_dump/pg_restore) cho các công cụ vận
# hành đội kho (issue #586): service migrate và các lệnh fleet:* khi
# vận hành gọi đều chạy trong chính image này. Bản công cụ phải khớp
# major với server Postgres của stack (18) — pg_dump cũ hơn server
# từ chối dump. Cài từ kho PGDG chính thức của PostgreSQL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && rm -rf /var/lib/apt/lists/*
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]

# ----- Runtime worker -----
# Tiến trình worker (BullMQ + outbox relay) đã biên dịch (dist/main.js);
# worker không mở cổng HTTP.
FROM node:24-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
USER node
CMD ["node", "dist/main.js"]

# ----- Runtime web -----
# Chạy thẳng server production của web (server/prod-server.mjs): phục vụ
# bản build SSR + tệp tĩnh và proxy /api/*, /socket.io/*, /mcp,
# /.well-known/* về API nội bộ qua biến LMS_API_INTERNAL_URL — giữ
# nguyên topology một-origin như đường chạy production hiện hành.
FROM node:24-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/web ./
USER node
EXPOSE 8080
CMD ["node", "server/prod-server.mjs"]
