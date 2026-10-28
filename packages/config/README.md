# @lms/config — README

> File này ghi các **quyết định còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách gì

`packages/config` chứa các **cấu hình TypeScript dùng chung** của monorepo
(`tsconfig/base.json`, `nest.json`, `react.json`) để mọi app/package biên dịch theo
cùng một kỷ luật kiểu. Package này **không mang quyết định nghiệp vụ nào** — ghi rõ
điều đó ở đây để không ai đi tìm (hoặc tự nhét) nghiệp vụ vào đây.

## Quyết định còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Hai dòng TypeScript tách riêng theo nền: dòng NestJS (apps/api, apps/worker) theo `nest.json` (TypeScript 6), dòng React (apps/web và các package giao diện) theo `react.json` (TypeScript 7). Không ép một dòng cho cả monorepo. | README gốc của repo (mục Version policy) |
| Mọi package kế thừa từ các base này thay vì tự khai tsconfig rời — kỷ luật kiểu (strictness, module resolution) là dùng chung, đổi một chỗ áp cho toàn hệ. | Cấu trúc monorepo hiện hành |

## Ranh giới — package này KHÔNG làm gì

- Không chứa code chạy (runtime), không chứa hằng số nghiệp vụ, không chứa cấu hình
  môi trường/secret: cấu hình nghiệp vụ cấp site thuộc site-config ở `apps/api` +
  hợp đồng ở `packages/contracts`; biến môi trường thuộc từng app.
- Không chứa ESLint rule nghiệp vụ riêng hay preset giao diện.

## Kỹ thuật tối thiểu

- Chỉ có các file JSON tsconfig; `typecheck`/`test`/`build` của package là no-op
  theo `package.json`.
