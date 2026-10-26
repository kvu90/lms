import '@testing-library/jest-dom/vitest';

/**
 * jsdom không cài đặt phép đo bố cục trên `Range` mà ProseMirror gọi mỗi
 * khi cuộn tới vùng chọn (`scrollIntoView` sau các lệnh focus/chèn): thiếu
 * nó thì mọi giao dịch soạn thảo ném `target.getClientRects is not a
 * function` dù trên trình duyệt thật chạy bình thường. Lắp bản đo rỗng ở
 * tầng môi trường test — test của package kiểm hành vi soạn/lưu/xem, không
 * kiểm hình học bố cục.
 */
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
