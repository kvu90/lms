import { describe, expect, it } from 'vitest';
import {
  isMatrixContentSignatureConflict,
  matrixContentSignature,
  type MatrixContentSignatureInput,
} from './matrix-content-signature';

/**
 * Kiểm đơn vị cho chữ ký nội dung ma trận (lát schema chống trùng,
 * issue #233): thuật toán là MỘT định nghĩa dùng chung cho tầng đối
 * chiếu trong code, cột `content_signature` ở DB và script lấp dữ
 * liệu — các ca ở đây khoá các bất biến mà chống trùng dựa vào:
 * không phụ thuộc thứ tự của tập phạm vi/ô, làm tròn điểm 4 chữ số
 * thập phân, và đổi bất kỳ thành phần nào cũng đổi chữ ký. Thêm ca
 * nhận diện va chạm: chỉ lỗi 23505 của ĐÚNG ràng buộc (bank, chữ ký)
 * mới được tính là trùng nội dung.
 */

const BASE: MatrixContentSignatureInput = {
  name: 'Ma trận giữa kỳ',
  subjectId: 'sub-1',
  curriculumId: 'cur-1',
  levelSet: 'three',
  totalScore: 10,
  scopeNote: null,
  scopeNodeIds: ['node-2', 'node-1'],
  cells: [
    { curriculumNodeId: 'node-1', cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 1 },
    { curriculumNodeId: 'node-1', cognitiveLevel: 'hieu', qtype: 'essay', questionCount: 1, cellScore: 2.5 },
  ],
};

describe('Hàm matrixContentSignature', () => {
  it('không phụ thuộc thứ tự của tập phạm vi và của các ô', () => {
    const reordered: MatrixContentSignatureInput = {
      ...BASE,
      scopeNodeIds: ['node-1', 'node-2'],
      cells: [...BASE.cells].reverse(),
    };
    expect(matrixContentSignature(reordered)).toBe(matrixContentSignature(BASE));
  });

  it('làm tròn điểm 4 chữ số thập phân: lệch dưới ngưỡng làm tròn thì chữ ký bằng nhau, lệch thật thì khác', () => {
    const tiny: MatrixContentSignatureInput = { ...BASE, totalScore: 10.00001 };
    expect(matrixContentSignature(tiny)).toBe(matrixContentSignature(BASE));
    const real: MatrixContentSignatureInput = { ...BASE, totalScore: 10.001 };
    expect(matrixContentSignature(real)).not.toBe(matrixContentSignature(BASE));
  });

  it('đổi từng thành phần (tên, bộ mức, ghi chú phạm vi, một ô) đều đổi chữ ký', () => {
    const base = matrixContentSignature(BASE);
    expect(matrixContentSignature({ ...BASE, name: 'Tên khác' })).not.toBe(base);
    expect(matrixContentSignature({ ...BASE, levelSet: 'four' })).not.toBe(base);
    expect(matrixContentSignature({ ...BASE, scopeNote: 'chỉ chương 1' })).not.toBe(base);
    expect(matrixContentSignature({ ...BASE, scopeNodeIds: ['node-1'] })).not.toBe(base);
    expect(matrixContentSignature({
      ...BASE,
      cells: BASE.cells.map((c, i) => (i === 0 ? { ...c, questionCount: 3 } : c)),
    })).not.toBe(base);
    expect(matrixContentSignature({ ...BASE, cells: [] })).not.toBe(base);
  });

  it('giữ nguyên dạng chuỗi của thuật toán đối chiếu hiện hành (JSON theo thứ tự trường cố định)', () => {
    expect(matrixContentSignature(BASE)).toBe(JSON.stringify({
      name: 'Ma trận giữa kỳ', subjectId: 'sub-1', curriculumId: 'cur-1',
      levelSet: 'three', totalScore: 10, scopeNote: null,
      scopeNodeIds: ['node-1', 'node-2'],
      cells: ['node-1|biet|multichoice|2|1', 'node-1|hieu|essay|1|2.5'],
    }));
  });
});

describe('Hàm isMatrixContentSignatureConflict', () => {
  it('nhận diện 23505 mang tên ràng buộc ở trường constraint', () => {
    const err = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'exam_matrices_bank_content_signature_unique',
    });
    expect(isMatrixContentSignatureConflict(err)).toBe(true);
  });

  it('nhận diện 23505 bọc trong cause của Drizzle, tên ràng buộc nằm trong message', () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "exam_matrices_bank_content_signature_unique"'),
      { code: '23505' },
    );
    const wrapped = new Error('Failed query', { cause: pgError });
    expect(isMatrixContentSignatureConflict(wrapped)).toBe(true);
  });

  it('23505 của ràng buộc khác (ô ma trận) KHÔNG phải trùng nội dung', () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "exam_matrix_cells_unique"'),
      { code: '23505', constraint: 'exam_matrix_cells_unique' },
    );
    expect(isMatrixContentSignatureConflict(err)).toBe(false);
  });

  it('lỗi không phải 23505 thì không phải va chạm', () => {
    expect(isMatrixContentSignatureConflict(new Error('boom'))).toBe(false);
    expect(isMatrixContentSignatureConflict(null)).toBe(false);
    expect(isMatrixContentSignatureConflict('23505')).toBe(false);
  });
});
