/**
 * Kênh sự kiện đổi sổ đăng ký không gian — cơ chế vô hiệu hoá bộ nhớ
 * đệm định tuyến theo sự kiện (issue #581).
 *
 * Vì sao là một emitter thuần ở tầng dữ kiện, không phải một service
 * Nest: hai phía của kênh nằm ở hai tầng ngược nhau. Phía PHÁT là
 * tầng quản trị sổ (`ControlPlaneRegistryService` — nơi mọi thao tác
 * ghi sổ: tạo, cập nhật, đổi trạng thái, đổi phiên bản schema — chạy
 * qua); phía NGHE là bộ phân giải kết nối ở tầng dữ kiện
 * (`SpaceConnectionResolver`). Nếu bộ phân giải là một provider mà
 * tầng quản trị phải inject, hai module sẽ phụ thuộc vòng lẫn nhau;
 * một hàm phát/nghe thuần ở tầng thấp nhất phá vòng đó — cùng tiền
 * lệ với singleton ALS `tenantAls` mà cả phía Nest lẫn phía hạ tầng
 * cùng đọc/ghi trực tiếp.
 *
 * Hợp đồng của kênh: nơi ghi sổ PHẢI phát sự kiện sau khi thay đổi
 * đã commit, kèm slug của không gian vừa đổi. Bộ phân giải nghe sự
 * kiện và xoá đúng mục đệm của slug đó; TTL ngắn trên từng mục đệm
 * là lưới dự phòng cho mọi thay đổi không đi qua kênh này (ví dụ
 * thao tác vận hành trực tiếp trên database control plane).
 *
 * Giới hạn liên tiến trình và kết luận áp dụng (issue #582): kênh
 * này chỉ tồn tại TRONG một tiến trình — API và worker mỗi tiến
 * trình giữ bộ nghe của riêng mình, không có kênh liên tiến trình
 * (không Redis pub/sub, không LISTEN/NOTIFY). Thay đổi sổ do tiến
 * trình khác ghi chỉ hội tụ vào bộ đệm của tiến trình này khi TTL
 * hết hạn (mặc định 5 giây, biến `SPACE_ROUTING_CACHE_TTL_MS`).
 * Độ hội tụ này được kết luận là ĐỦ cho cả định tuyến request lẫn
 * định tuyến job, vì hai lý do: job outbox idempotent theo
 * `outboxId` nên một job bị phát/xử lý theo ảnh chụp sổ cũ trong
 * cửa sổ TTL vẫn an toàn khi chạy lại; và việc đổi chế độ kho hay
 * trạng thái của một trung tâm là thao tác di trú/cấp phát có kế
 * hoạch, không phải thay đổi tức thời theo traffic. Đợt này vì
 * vậy KHÔNG dựng kênh liên tiến trình; nhu cầu hội tụ tức thời
 * thật (nếu phát sinh) là việc riêng có đặc tả riêng.
 */

/** Hàm huỷ đăng ký nghe — gọi khi bên nghe kết thúc vòng đời. */
export type SpaceRegistryChangedUnsubscribe = () => void;

type SpaceRegistryChangedListener = (slug: string) => void;

const listeners = new Set<SpaceRegistryChangedListener>();

/**
 * Đăng ký nghe sự kiện đổi sổ đăng ký.
 *
 * @param listener - Hàm được gọi với slug của không gian vừa đổi,
 *   chạy đồng bộ ngay trong lượt phát.
 * @returns Hàm huỷ đăng ký; gọi để bên nghe ngừng nhận sự kiện.
 */
export function onSpaceRegistryChanged(listener: SpaceRegistryChangedListener): SpaceRegistryChangedUnsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Phát sự kiện "dòng đăng ký của một không gian vừa đổi" — gọi SAU
 * khi thay đổi trên sổ đã commit thành công (phát trước commit sẽ
 * làm bên nghe đọc lại đúng giá trị cũ và đệm lại giá trị cũ).
 *
 * @param slug - Slug của không gian vừa đổi trạng thái/phiên bản/cấu
 *   hình định tuyến.
 */
export function emitSpaceRegistryChanged(slug: string): void {
  for (const listener of listeners) listener(slug);
}
