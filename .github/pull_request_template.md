**[ĐỘI MUSE — <vai trò của đội mở PR>]**

<!--
QUY TẮC BẮT BUỘC — PR TỰ CHỨA:
- Đối chiếu nghiệm thu phải viết ngay trong PR này, từng tiêu chí kèm
  bằng chứng.
- CẤM trích dẫn mơ hồ kiểu "theo quyết định đã chốt", "như đã thống nhất"
  thay cho nội dung. Quyết định liên quan dẫn từ issue liên kết (nơi nội
  dung quyết định đã được viết trọn vẹn) hoặc viết lại đầy đủ tại đây.
- CẤM dẫn file, tài liệu, ghi chú nằm ngoài repo này làm căn cứ. Chỉ dẫn
  tài liệu nằm trong repo, theo đường dẫn trong repo.
- Viết bằng tiếng Việt, văn phong kỹ thuật trung tính; không dùng danh
  xưng hay cách xưng hô nội bộ trong văn bản.
- Giữ nguyên các tiêu đề mục dưới đây; xoá các khối comment hướng dẫn này
  trước khi gửi.
-->

## Liên kết issue

<!-- - Lát giữa của một việc nhiều lát: ghi "Refs #<số issue>".
     - Lát cuối hoặc PR duy nhất của việc: ghi "Closes #<số issue>".
     Ghi rõ PR này là lát nào của issue và còn lát nào sau nó (nếu có). -->

## Tóm tắt thay đổi

<!-- Thay đổi gì, vì sao, bám theo mục nào của issue liên kết. -->

## Bản đồ thay đổi theo phạm vi

<!-- Liệt kê từng file/module đã đụng, thay đổi gì và lý do. -->

| File / module | Thay đổi | Lý do |
| --- | --- | --- |
|  |  |  |

## Đối chiếu tiêu chí nghiệm thu của issue

<!-- Sao chép TỪNG tiêu chí trong mục "Nghiệm thu" của issue liên kết.
Mỗi tiêu chí ghi: đã đáp ứng thế nào + bằng chứng cụ thể (test nào, log
nào, ảnh nào, số liệu nào). Tiêu chí chưa đáp ứng thì ghi rõ lý do và
việc còn lại, không để trống. -->

- [ ] <tiêu chí 1 của issue> — Đáp ứng: <cách đáp ứng>. Bằng chứng: <bằng chứng>.

## Kiểm chứng đã chạy

<!-- Lệnh đã chạy ở local và kết quả thật (typecheck package đã đụng, test
targeted của phần đã đụng). Trạng thái CI: job `verify` trên head của PR
này — kết luận chỉ lấy từ log thật của job. -->

## Kỷ luật đã giữ

- [ ] Comment trong code và tài liệu của PR này bằng tiếng Việt; code
  bằng tiếng Anh.
- [ ] Comment nghiệp vụ tiếng Việt trong code đã được cập nhật nếu có đổi
  code; comment lệch code thật được sửa trong cùng lượt với sửa code.
- [ ] Tài liệu còn giữ trong repo (README/AGENTS.md của package liên quan)
  đã được cập nhật nếu thay đổi này ảnh hưởng tới chúng.
- [ ] Test bám spec và mục Nghiệm thu của issue; không yếu hoá assertion
  để cho qua.
- [ ] Không tự merge — PR chờ đánh giá độc lập.

## Ngoài phạm vi / việc chưa làm

<!-- Những gì cố ý không làm trong PR này, việc phát sinh ghi nhận nhưng
thuộc issue khác, và lý do. Không có thì ghi "Không có". -->
