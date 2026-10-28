/**
 * Khối chọn lớp dùng chung ở tầng ứng dụng: một phần tử select cho người
 * dùng chọn một lớp làm bối cảnh (hiện tại dùng ở bước lớp của wizard
 * tạo khoá học).
 *
 * Khuôn của khối (đo trên toàn bộ giao diện): trang gọi tải danh sách lớp
 * rồi tự dựng select với một tuỳ chọn rỗng ở đầu và chỉ các lớp đang
 * hoạt động (`status === 'active'`) mới là lựa chọn hợp lệ. Component
 * này là nơi duy nhất dựng khuôn đó; trang gọi truyền danh sách lớp,
 * giá trị đang chọn và handler thay đổi — tập lựa chọn, giá trị mặc
 * định do trang giữ và hiệu ứng khi đổi lựa chọn giữ nguyên như khi tự
 * dựng tại chỗ.
 */

/** Một lớp trong danh sách chọn: chỉ cần định danh, tên và trạng thái vòng đời. */
export interface ClassPickerOption {
  /** Định danh lớp — cũng là giá trị của tuỳ chọn. */
  id: string;
  /** Tên lớp hiển thị trong danh sách chọn. */
  name: string;
  /** Trạng thái vòng đời của lớp; chỉ `active` mới xuất hiện trong danh sách chọn. */
  status: string;
}

/** Props của khối chọn lớp dùng chung. */
export interface ClassPickerProps {
  /** Id của phần tử select, để nhãn của trang gọi liên kết tới (`htmlFor`). */
  id?: string;
  /** Toàn bộ danh sách lớp của trang gọi (component tự lọc lớp đang hoạt động). */
  classes: ClassPickerOption[];
  /** Giá trị đang chọn (id lớp, hoặc chuỗi rỗng khi chưa chọn). */
  value: string;
  /** Handler khi người dùng đổi lựa chọn — nhận id lớp mới (hoặc chuỗi rỗng). */
  onChange: (classId: string) => void;
  /** Nhãn của tuỳ chọn rỗng ở đầu danh sách (trang gọi truyền chuỗi đã dịch). */
  emptyLabel: string;
  /** Lớp CSS của phần tử select (trang gọi truyền khuôn select đang dùng của nó). */
  className?: string;
}

/**
 * Khối chọn lớp dùng chung.
 *
 * @param props - Danh sách lớp, giá trị đang chọn, handler thay đổi và nhãn tuỳ chọn rỗng.
 * @returns Phần tử select gồm tuỳ chọn rỗng và các lớp đang hoạt động theo thứ tự danh sách gốc.
 */
export function ClassPicker({ id, classes, value, onChange, emptyLabel, className }: ClassPickerProps) {
  return (
    <select id={id} className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {classes
        .filter((c) => c.status === 'active')
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );
}
