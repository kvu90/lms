/**
 * Kiểm chứng EXHAUSTIVE cho số kiểm tra của mã tô CAM-0 (issue #112,
 * sửa theo phán quyết 6393776449 trên PR #120): bộ trọng số cũ (3, 5,
 * 7) cho mã lớp và (3, 5, 7, 9, 1, 3, 5) cho mã SBD chứa trọng số 5
 * với gcd(5, 10) = 5, nên đột biến 1 chữ số với delta CHẴN ở vị trí
 * trọng số 5 lọt qua số kiểm tra và gán nhầm học sinh khác (12,70%
 * đột biến SBD, 14,81% đột biến mã lớp theo probe của đội đánh giá).
 * Bộ trọng số mới — mã lớp (3, 9, 7), SBD (3, 9, 7, 9, 1, 3, 9) — mọi
 * trọng số đều nguyên tố cùng nhau với 10. File này khoá tính chất đó
 * bằng liệt kê đầy đủ, không lấy mẫu tượng trưng:
 *  - mã lớp: TOÀN BỘ 999 mã × mọi vị trí × mọi chữ số thay thế;
 *  - mã SBD: 10.000 mã đầu × mọi vị trí × mọi chữ số thay thế, cộng
 *    các mã có một chữ số khác 0 ở từng vị trí thân cao (phủ đủ bộ ba
 *    (vị trí, chữ số gốc, chữ số thay) cho cả 7 vị trí thân — tính
 *    chất tuyến tính của tổng có trọng số làm phép liệt kê này đầy
 *    đủ cho mọi mã);
 *  - va chạm roster: đột biến ở đúng vị trí/delta từng lọt không
 *    được trở thành mã hợp lệ của bất kỳ học sinh nào trong roster;
 *  - hoán vị hai chữ số kề: ca duy nhất lọt là cặp hơn kém đúng 5
 *    (giới hạn toán học đã tuyên bố trong sheet-layout.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  sbdCodeChecksumOk, sbdCodeForIndex, sbdIndexForCode,
  studentCodeChecksumOk, studentCodeForIndex, studentIndexForCode,
} from './sheet-layout';

const LONG = { timeout: 300_000 };

function mutations(code: string): string[] {
  const out: string[] = [];
  for (let pos = 0; pos < code.length; pos++) {
    for (let a = 0; a <= 9; a++) {
      if (String(a) === code[pos]) continue;
      out.push(`${code.slice(0, pos)}${a}${code.slice(pos + 1)}`);
    }
  }
  return out;
}

describe('CAM-0 check digit — exhaustive single-digit mutation coverage', () => {
  it('student codes (4-digit): every mutation of every valid code is rejected', LONG, () => {
    let checked = 0;
    let leaks = 0;
    for (let index = 0; index <= 998; index++) {
      const code = studentCodeForIndex(index);
      expect(studentCodeChecksumOk(code)).toBe(true);
      expect(studentIndexForCode(code)).toBe(index);
      for (const mutated of mutations(code)) {
        checked++;
        if (studentCodeChecksumOk(mutated) || studentIndexForCode(mutated) !== null) leaks++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[CAM-0 checksum] student codes: ${checked} mutations checked, ${leaks} leaks`);
    expect(checked).toBe(999 * 4 * 9);
    expect(leaks).toBe(0);
  });

  it('SBD codes (8-digit): every mutation across full (position, from-digit, to-digit) coverage is rejected', LONG, () => {
    let checked = 0;
    let leaks = 0;
    const checkCode = (code: string) => {
      expect(sbdCodeChecksumOk(code)).toBe(true);
      for (const mutated of mutations(code)) {
        checked++;
        if (sbdCodeChecksumOk(mutated) || sbdIndexForCode(mutated) !== null) leaks++;
      }
    };
    // 10.000 mã đầu: phủ mọi đột biến ở mọi vị trí (thân + số kiểm tra).
    for (let index = 0; index < 10_000; index++) checkCode(sbdCodeForIndex(index));
    // Các vị trí thân cao (0..2) trong 10.000 mã đầu chỉ mang chữ số 0;
    // bổ sung mã có đúng một chữ số d ∈ 1..9 tại từng vị trí thân để phủ
    // đủ (vị trí, chữ số gốc, chữ số thay) cho cả 7 vị trí.
    for (let pos = 0; pos < 7; pos++) {
      for (let d = 1; d <= 9; d++) {
        const body = Array.from({ length: 7 }, (_, k) => (k === pos ? String(d) : '0')).join('');
        const index = Number(body) - 1;
        if (index < 0) continue;
        checkCode(sbdCodeForIndex(index));
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[CAM-0 checksum] SBD codes: ${checked} mutations checked, ${leaks} leaks`);
    expect(checked).toBe((10_000 + 7 * 9) * 8 * 9);
    expect(leaks).toBe(0);
  });

  it('roster collision: mutations at the previously-leaking positions never become another roster member code', LONG, () => {
    // Mã lớp: vị trí 1 (trọng số 5 cũ), delta +2 → thân tăng 20. Roster
    // liên tiếp 1..45 như ca đội đánh giá đã chứng minh gán nhầm.
    const classRoster = new Set(Array.from({ length: 45 }, (_, i) => studentCodeForIndex(i)));
    let classChecked = 0;
    for (let index = 0; index < 45; index++) {
      const code = studentCodeForIndex(index);
      for (const delta of [2, 4, 6, 8]) {
        const mutated = `${code[0]}${(Number(code[1]) + delta) % 10}${code.slice(2)}`;
        classChecked++;
        expect(classRoster.has(mutated), `mutated class code ${mutated} (from ${code}) must not be a roster code`).toBe(false);
        expect(studentCodeChecksumOk(mutated)).toBe(false);
      }
    }
    // SBD: hai vị trí trọng số 5 cũ là 1 và 6, delta chẵn bất kỳ.
    const sbdRoster = new Set(Array.from({ length: 45 }, (_, i) => sbdCodeForIndex(i)));
    let sbdChecked = 0;
    for (let index = 0; index < 45; index++) {
      const code = sbdCodeForIndex(index);
      for (const pos of [1, 6]) {
        for (const delta of [2, 4, 6, 8]) {
          const mutated = `${code.slice(0, pos)}${(Number(code[pos]) + delta) % 10}${code.slice(pos + 1)}`;
          sbdChecked++;
          expect(sbdRoster.has(mutated), `mutated SBD ${mutated} (from ${code}) must not be a roster code`).toBe(false);
          expect(sbdCodeChecksumOk(mutated)).toBe(false);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[CAM-0 checksum] roster collision: class ${classChecked} + SBD ${sbdChecked} targeted mutations, 0 collisions`);
  });

  it('adjacent transposition: the only escaping class is a digit pair differing by exactly 5 (declared limit)', LONG, () => {
    const checkTranspositions = (code: string, ok: (c: string) => boolean) => {
      for (let pos = 0; pos < code.length - 2; pos++) { // chỉ hoán vị trong phần thân, không đụng số kiểm tra
        const a = Number(code[pos]);
        const b = Number(code[pos + 1]);
        if (a === b) continue;
        const swapped = `${code.slice(0, pos)}${b}${a}${code.slice(pos + 2)}`;
        if (ok(swapped)) expect(Math.abs(a - b), `transposition ${code} -> ${swapped} escaped`).toBe(5);
      }
    };
    for (let index = 0; index <= 998; index++) checkTranspositions(studentCodeForIndex(index), studentCodeChecksumOk);
    for (let index = 0; index < 10_000; index++) checkTranspositions(sbdCodeForIndex(index), sbdCodeChecksumOk);
  });
});
