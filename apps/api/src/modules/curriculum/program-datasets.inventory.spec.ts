import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProgramDataset, PROGRAM_DATASETS } from './program-datasets';

/**
 * Issue #161 — spec gác tính đầy đủ của dataset GDPT 2018 đã vendor.
 *
 * Vì sao phải khoá cứng con số trong spec: tổng số bản ghi từng đổi
 * lặng lẽ từ 2.126 xuống 2.115 khi đợt tách YCCĐ (PR #245) gộp 11 cặp
 * bản ghi bị công cụ trích xuất cắt đôi một ô qua ranh trang (gộp về
 * bản ghi đầu, giữ id của bản ghi đầu, có log từng cặp kèm trang PDF).
 * Khi đó không có spec nào khẳng định tổng số nên không spec nào đỏ,
 * và chữ "2.126" tiếp tục sống trong comment + chuỗi hiển thị cho
 * admin một thời gian dài sau khi dữ liệu thật đã khác.
 *
 * Spec này biến kiểm kê dataset thành bất biến có test giữ:
 *  - manifest `PROGRAM_DATASETS` và thư mục `program-data/` trên đĩa
 *    phải khớp nhau hai chiều (file có trong manifest thì phải có
 *    trên đĩa và ngược lại);
 *  - số bản ghi của TỪNG dataset và tổng toàn bộ phải bằng đúng bảng
 *    đã kiểm chứng dưới đây (đếm trực tiếp từ file JSON ngày
 *    27/10/2026, khớp cả artifact dump đông cứng ở cả 5 bảng);
 *  - số môn đích phân biệt theo `slug` phải là 19 (môn thứ 20 danh
 *    nghĩa GDQP&AN chưa có dataset — hoãn theo issue #74).
 *
 * Hệ quả có chủ đích: dataset được đính chính hợp lệ (có quyết định
 * và log kèm theo) thì spec này ĐỎ, và người đính chính phải cập
 * nhật bảng số trong cùng PR — đó là cách con số trong code không
 * bao giờ lệch dữ liệu thật âm thầm lần nữa. Đây là test về hợp
 * đồng dữ liệu chuẩn của hệ thống, không phải test chi tiết triển
 * khai: nạp thiếu/thừa một dataset hay mất một bản ghi đều là lỗi
 * nghiệp vụ mà admin và giáo viên nhìn thấy trực tiếp.
 */

/** Số bản ghi đã kiểm chứng theo khoá dataset (tổng 2.164). */
const EXPECTED_RECORDS: Readonly<Record<string, number>> = {
  toan: 314,
  nguvan: 238,
  'tienganh-1-2': 16,
  'tienganh-3-12': 95,
  gdcd: 116,
  tnxh: 48,
  khoahoc: 32,
  'lsdl-th': 49,
  'lsdl-thcs': 64,
  lichsu: 110,
  diali: 63,
  khtn: 131,
  vatli: 82,
  hoahoc: 94,
  sinhhoc: 133,
  tinhoc: 115,
  congnghe: 121,
  gdtc: 22,
  amnhac: 116,
  mithuat: 100,
  hdtn: 105,
};

describe('Dataset GDPT 2018 đã vendor — gác tính đầy đủ (issue #161)', () => {
  it('manifest có đúng 21 dataset và khớp hai chiều với file trên đĩa', () => {
    expect(PROGRAM_DATASETS).toHaveLength(21);
    const onDisk = readdirSync(join(__dirname, 'program-data'))
      .filter((name) => name.endsWith('.json'))
      .sort();
    const inManifest = PROGRAM_DATASETS.map((d) => d.fileName).sort();
    expect(inManifest).toEqual(onDisk);
  });

  it('số bản ghi từng dataset và tổng toàn bộ khớp bảng đã kiểm chứng (2.164)', () => {
    let total = 0;
    for (const def of PROGRAM_DATASETS) {
      const file = loadProgramDataset(def);
      expect(
        file.records.length,
        `dataset ${def.key} (${def.fileName}) lệch số bản ghi đã kiểm chứng`,
      ).toBe(EXPECTED_RECORDS[def.key]);
      total += file.records.length;
    }
    expect(total).toBe(2164);
  });

  it('21 dataset resolve về đúng 19 môn đích phân biệt', () => {
    const slugs = new Set(PROGRAM_DATASETS.map((d) => d.slug));
    expect(slugs.size).toBe(19);
  });
});
