/**
 * Bộ giới hạn đồng thời cho các vòng quét nhiều trung tâm (issue
 * #582).
 *
 * Khi relay outbox quét lần lượt outbox của từng trung tâm ở kho
 * riêng, mỗi trung tâm đang quét giữ pool kết nối của kho đó mở.
 * Quét không giới hạn sẽ mở đồng thời pool của MỌI trung tâm —
 * tổng kết nối tới cụm Postgres phình theo số trung tâm, phá kỷ
 * luật ngân sách kết nối của khung định tuyến. Hàm trong file này
 * chạy một danh sách việc bất đồng bộ với trần việc chạy đồng thời
 * cấu hình được (`SPACE_SWEEP_CONCURRENCY` phía worker): tại mọi
 * thời điểm có tối đa `limit` việc đang chạy; việc kết thúc thì
 * việc kế tiếp trong danh sách được bắt đầu ngay.
 */

/**
 * Chạy `fn` cho từng phần tử của `items` với tối đa `limit` lượt
 * chạy đồng thời.
 *
 * Thứ tự BẮT ĐẦU tuân theo thứ tự của `items`; thứ tự KẾT THÚC
 * không được bảo đảm (việc ngắn kết thúc trước việc dài bắt đầu
 * sớm hơn). Lỗi của một lượt chạy được truyền ra qua promise trả
 * về (các lượt đang chạy dở vẫn chạy tới xong trong nền); bên gọi
 * cần cô lập lỗi theo từng phần tử thì tự bắt lỗi bên trong `fn`.
 *
 * @param items - Danh sách phần tử cần xử lý.
 * @param limit - Trần lượt chạy đồng thời; giá trị nhỏ hơn 1 hoặc
 *   không hợp lệ được kẹp về 1 (chạy tuần tự).
 * @param fn - Việc bất đồng bộ cho một phần tử.
 */
export async function mapWithConcurrencyLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const effectiveLimit = Math.max(1, Math.floor(limit) || 1);
  let nextIndex = 0;
  const workerCount = Math.min(effectiveLimit, items.length);
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < workerCount; w += 1) {
    workers.push(
      (async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          await fn(items[index]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
