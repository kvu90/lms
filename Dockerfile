# Image triển khai Heroku (Container Registry & Runtime): một image nền
# chứa toàn bộ monorepo đã build, ba target cuối chỉ khác lệnh chạy —
# web (API + giao diện tĩnh), worker (BullMQ) và release (migrate + seed
# dữ liệu review, chạy một lần trước mỗi bản phát hành).
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM base AS runtime
# curl để Heroku stream log của release phase (theo tài liệu Container
# Registry & Runtime); thiếu nó log vẫn xem được qua log của app.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
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
