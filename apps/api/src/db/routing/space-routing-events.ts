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
