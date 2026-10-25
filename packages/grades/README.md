# @lms/grades — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật cao nhất về quyết định: sổ quyết định `~/workspace/lms-nest-ops/decisions.md`.

## Package phụ trách nghiệp vụ gì

`packages/grades` là **bộ máy tính điểm dùng chung** của hệ thống: bộ đánh giá công
thức điểm (grade formula) và bộ tính tổng hợp điểm (grade calculator) mà sổ điểm của
`apps/api` dùng — hợp nhất về một package duy nhất (issue #137) để **mọi bề mặt tính
điểm cùng một kết quả**: điểm GV thấy khi chốt, điểm HS/PH thấy sau công bố, và điểm
xuất vnEdu không bao giờ được lệch nhau vì hai bản cài đặt công thức khác nhau.
Ngữ nghĩa tính toán ở đây bám Moodle (sàn tối thiểu của sản phẩm) và đã được chốt rõ
ở những điểm Moodle không định nghĩa hết.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Công thức điểm viết theo cú pháp Moodle: bắt đầu bằng `=`, tham chiếu grade item bằng `[[idNumber]]`, hàm lõi `sum/average/min/max`… Đánh giá bằng **parser an toàn, KHÔNG dùng `eval`** — công thức do GV nhập là dữ liệu, không phải code. | `grade-formula.ts` (oracle: MoodleDocs "Grade calculations", tra 23/10/2026) |
| Ngữ nghĩa điểm trống đã chốt: chia cho 0 → **null** (không có điểm), không lỗi/Infinity. Điểm trống truyền qua phép toán hai ngôi thành null; riêng `sum/average/min/max` BỎ QUA đối số trống, chỉ null khi mọi đối số đều trống. | `grade-formula.ts` |
| `round` theo ngữ nghĩa PHP của Moodle: làm tròn nửa **ra xa số 0** (round(2.5)=3, round(-2.5)=-3). `mod` giữ dấu của số bị chia (fmod); `if` đánh giá lười; toán tử so sánh cho 1/0 và không chuỗi được. Hàm ngoài tập lõi bị **từ chối lúc phân tích cú pháp bằng lỗi rõ ràng** — không âm thầm tính sai. | `grade-formula.ts` |
| Tính đúng của bộ máy được khoá bằng **parity corpus** (`parity-corpus.ts` + `grade-parity.spec.ts`): tập ca đối chiếu kết quả với Moodle. Đổi ngữ nghĩa tính toán mà corpus không đổi theo quyết định mới = chưa xong. | Issue #137 |
| Công thức ĐTB theo TT 22/2021 (ĐTBmhk = (TĐĐGtx + 2×ĐĐGgk + 3×ĐĐGck)/(số ĐĐGtx + 5); ĐTBmcn = (ĐTBmhkI + 2×ĐTBmhkII)/3; làm tròn 1 chữ số) là **nghiệp vụ của sổ điểm VN ở apps/api**, dùng bộ máy này làm nền tính — không hard-code TT 22 vào engine dùng chung. | Research sổ điểm 24/10/2026; sổ mục B |

## Ranh giới — package này KHÔNG làm gì

- Không biết khái niệm học kỳ/môn/lớp/học sinh: engine thuần trên số và công thức.
  Mọi ánh xạ nghiệp vụ (cột điểm nào là ĐĐGtx/gk/ck, chốt, công bố) nằm ở `apps/api`.
- Không truy cập DB, không có trạng thái, không làm tròn "theo cảm giác" ngoài các
  luật đã chốt ở trên.
- Không chứa giao diện sổ điểm (đó là `apps/web` + module grades/vn-books ở API).

## Kỹ thuật tối thiểu

- Nguồn: `grade-formula.ts` (parser + đánh giá), `grade-calculator.ts` (tổng hợp),
  `parity-corpus.ts` (ca đối chiếu); test: `*.spec.ts` cùng thư mục.
