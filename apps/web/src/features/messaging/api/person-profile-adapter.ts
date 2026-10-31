/**
 * Lớp ADAPTER dữ kiện hồ sơ người cho bề mặt chat (issue #591 —
 * đợt dựng giao diện giống hệt demo trước, nối backend sau).
 *
 * Bối cảnh: panel thông tin của bản demo bày hồ sơ người đầy đủ
 * (giới thiệu, email, điện thoại, website, công ty, quốc gia,
 * múi giờ, địa điểm, trạng thái sẵn sàng, các thẻ), nhưng hợp
 * đồng dữ kiện người dùng phía chat hiện tại chỉ có định danh,
 * tên hiển thị và tên đăng nhập (`PersonSummary`). Mọi trường
 * backend chưa có PHẢI đi qua lớp adapter này — component không
 * tự chứa dữ kiện tạm và không bịa giá trị: trường nào chưa có
 * nguồn thì adapter trả `null` (hoặc danh sách rỗng), và panel
 * KHÔNG dựng hàng của trường đó (đúng luật hiển thị của bản
 * demo, căn ở issue #608 — trước đây panel hiện dấu gạch ngang
 * ở vị trí của trường, đã bỏ).
 *
 * Đợt backend (#592) chỉ thay nguồn dữ kiện của các hàm trong
 * file này (đọc từ API thật khi hợp đồng có đủ trường); chữ ký
 * và hình dạng trả về giữ nguyên để component không phải sửa.
 */
import type { PersonSummary } from '../types/types';

/**
 * Hình dạng hồ sơ người mà panel thông tin tiêu thụ. Các trường
 * đánh dấu chờ backend là các trường hợp đồng hiện tại chưa có;
 * chúng mang giá trị `null`/rỗng cho tới khi đợt backend cấp
 * nguồn thật qua adapter này.
 */
export interface PersonProfileView {
  /** Định danh người dùng (có thật từ hợp đồng hiện tại). */
  userId: string;
  /** Tên hiển thị (có thật từ hợp đồng hiện tại). */
  displayName: string;
  /** Tên đăng nhập (có thật từ hợp đồng hiện tại). */
  username: string;
  /**
   * Dòng vai trò dưới tên (ví dụ vai trong ngữ cảnh lớp/khoá) —
   * nơi gọi có ngữ cảnh roster thì truyền vào; chat 1–1 không có
   * ngữ cảnh vai nên để trống, CHỜ ĐỢT BACKEND #592 thay nguồn.
   */
  roleLine: string | null;
  /** Giới thiệu bản thân — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  bio: string | null;
  /** Email liên hệ — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  email: string | null;
  /** Số điện thoại — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  phone: string | null;
  /** Website cá nhân — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  website: string | null;
  /** Công ty / đơn vị — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  company: string | null;
  /** Quốc gia — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  country: string | null;
  /** Múi giờ — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  timezone: string | null;
  /** Địa điểm — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  location: string | null;
  /** Trạng thái sẵn sàng (ví dụ "sẵn sàng trao đổi") — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  availability: string | null;
  /** Các thẻ gắn với người — CHỜ ĐỢT BACKEND #592 thay nguồn. */
  tags: string[];
}

/**
 * Dựng hồ sơ hiển thị cho panel thông tin từ tóm tắt người dùng
 * hiện có. Chỉ ba trường định danh/tên là dữ kiện thật; mọi
 * trường hồ sơ mở rộng trả `null`/rỗng (xem TSDoc của file).
 *
 * @param person - Tóm tắt người dùng từ hợp đồng hiện tại.
 * @param roleLine - Dòng vai trò do nơi gọi suy từ ngữ cảnh
 *   roster của nó (nếu có); bỏ qua thì để trống.
 * @returns Hồ sơ hiển thị cho panel thông tin.
 */
export function getPersonProfile(person: PersonSummary, roleLine?: string | null): PersonProfileView {
  return {
    userId: person.userId,
    displayName: person.displayName,
    username: person.username,
    roleLine: roleLine ?? null,
    bio: null,
    email: null,
    phone: null,
    website: null,
    company: null,
    country: null,
    timezone: null,
    location: null,
    availability: null,
    tags: [],
  };
}

/**
 * Một tệp đã chia sẻ trong hội thoại — hình dạng cho khối tệp
 * của panel thông tin. Đính kèm tệp là điểm CHƯA có phán quyết
 * về chức năng và backend chưa có dữ kiện đính kèm nào, nên
 * nguồn hiện tại luôn rỗng; đợt backend chỉ thay nguồn của hàm
 * này khi điểm đính kèm được phán quyết và thi công.
 */
export interface SharedFileView {
  /** Định danh tệp. */
  id: string;
  /** Tên tệp hiển thị. */
  name: string;
  /** Nhãn dung lượng đã định dạng (ví dụ "1.2 MB"); nguồn hiện tại chưa có nên để trống. */
  sizeLabel?: string;
}

/**
 * Danh sách tệp đã chia sẻ của một hội thoại cho panel thông
 * tin — hiện luôn rỗng vì chưa có nguồn dữ kiện (xem
 * {@link SharedFileView}); panel chỉ hiện khối tệp khi danh
 * sách có phần tử, đúng hành vi của bản demo (điểm G9).
 *
 * @param conversationId - Hội thoại cần lấy tệp (giữ chữ ký
 *   cho đợt backend; đợt này chưa dùng tới vì chưa có nguồn).
 * @returns Danh sách tệp đã chia sẻ (hiện rỗng).
 */
export function getSharedFiles(conversationId: string): SharedFileView[] {
  // Đợt UI chưa có nguồn dữ kiện tệp: tham số chỉ giữ chữ ký
  // cho đợt backend #592 thay nguồn, kết quả luôn rỗng.
  void conversationId;
  return [];
}

/**
 * Mẫu chip trả lời nhanh phía trên ô soạn — CHỈ LÀ HÌNH DẠNG
 * (issue #591): chip trả lời nhanh là điểm chưa có phán quyết
 * về chức năng và không có nguồn dữ kiện nào, nên các chip này
 * chỉ hiện đúng hình dạng của demo ở trạng thái vô hiệu, không
 * chèn nội dung nào vào ô soạn. Khi điểm này có phán quyết,
 * nguồn mẫu được thay tại đây.
 */
export const QUICK_REPLY_SHAPE_SAMPLES: readonly string[] = ['Xin chào', 'Cảm ơn bạn', 'Đã rõ'];
