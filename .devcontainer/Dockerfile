# Image của môi trường phát triển Dev Container — CHỈ phục vụ phát triển
# trong container, KHÔNG phải image triển khai. Đường triển khai bằng
# Docker đã bỏ khỏi repo (xem mục "Develop in a Dev Container" ở README
# gốc); triển khai chạy theo đường buildpack được mô tả ở mục Review.
#
# Nền Node 24 khớp `.nvmrc` và trường `engines` của package.json gốc.
# pnpm được cấp qua corepack theo đúng phiên bản ghim ở trường
# `packageManager` (pnpm@12.14.0) — không cài pnpm toàn cục bằng npm.
FROM node:24-bookworm

# corepack có sẵn trong Node 24; bật shim pnpm. Phiên bản pnpm cụ thể do
# corepack tự lấy theo trường packageManager khi chạy trong thư mục repo
# (bước post-create của devcontainer.json kích hoạt sẵn một lần).
RUN corepack enable

# Client PostgreSQL để tiện dùng psql kiểm tra dữ liệu trong lúc phát
# triển. Đây chỉ là công cụ client — server PostgreSQL 18.6 chạy ở
# service `db` của docker-compose.yml cùng thư mục.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*
