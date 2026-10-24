# Topology C (Giai đoạn 4 của issue #7): dyno web chạy launcher — tiến
# trình SSR bind $PORT (mặt tiền duy nhất) + API ở cổng nội bộ, API không
# còn phục vụ tĩnh web. Merge PR này vào main CHỈ sau khi dyno web đã
# nâng lên Standard-2X (đo RAM GĐ3/GĐ4: cặp tiến trình đỉnh ≈484 MB,
# Eco 512 MB là NO-GO) — main chat điều phối cửa sổ merge.
web: node apps/web/server/launcher.mjs
worker: node apps/worker/dist/main.js
