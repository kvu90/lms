/**
 * Kiểm chứng EXHAUSTIVE cho số kiểm tra của mã tô CAM-0 (issue #112,
 * sửa theo phán quyết 6393776449 trên PR #120): bộ trọng số cũ (3, 5,
 * 7) cho mã lớp và (3, 5, 7, 9, 1, 3, 5) cho mã SBD chứa trọng số 5
 * với gcd(5, 10) = 5, nên đột biến 1 chữ số với delta CHẴN ở vị trí
 * trọng số 5 lọt qua số kiểm tra và gán nhầm học sinh khác (12,70%
 * đột biến SBD, 14,81% đột biến mã lớp theo probe của đội đánh giá).
 * Bộ trọng số mới — mã lớp (3, 9, 7), SBD (3, 9, 7, 9, 1, 3, 7) — mọi
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
 *  - hoán vị hai chữ số kề ở MỌI vị trí, KỂ CẢ cặp biên (chữ số thân
 *    cuối ↔ số kiểm tra): ca duy nhất lọt là cặp hơn kém đúng 5
 *    (giới hạn toán học đã tuyên bố trong sheet-layout.ts);
 *  - va chạm roster ở cặp biên: hoán vị hai ký tự cuối với cặp chữ
 *    số KHÔNG hơn kém 5 bị checksum chặn, không khớp mã của bất kỳ
 *    học sinh nào khác. Khoá theo phán quyết 6394453120: vòng trước
 *    trọng số thân cuối SBD là 9 ≡ −1 (mod 10) — bằng trọng số hiệu
 *    dụng của vị trí số kiểm tra — nên cặp biên lọt với mọi cặp chữ
 *    số; spec cũ tự loại cặp biên khỏi vòng hoán vị nên không bắt
 *    được. Nay trọng số cuối là 7, hiệu cặp biên −8 như mọi cặp kề.
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
      // MỌI cặp kề: pos chạy tới cặp biên (chữ số thân cuối ↔ số kiểm
      // tra) — vòng cũ dừng ở code.length - 2 nên bỏ sót đúng cặp này.
      for (let pos = 0; pos < code.length - 1; pos++) {
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

  it('roster edge pair: transposing the last two digits never lands on another roster code unless the digits differ by exactly 5', LONG, () => {
    // Đúng ca của phán quyết 6394453120: với trọng số thân cuối cũ 9,
    // sbdCodeForIndex(0) = 00000019 hoán vị cuối thành 00000091 — mã
    // THẬT của thí sinh chỉ số 8 — và checksum vẫn nhận. Nay mã của
    // chỉ số 0 là 00000017, hoán vị cuối 00000071 bị checksum chặn.
    expect(sbdCodeForIndex(0)).toBe('00000017');
    expect(sbdCodeChecksumOk('00000071')).toBe(false);
    expect(sbdCodeChecksumOk('00000091')).toBe(false);

    const checkEdge = (codes: string[], ok: (c: string) => boolean, label: string) => {
      const roster = new Set(codes);
      let checked = 0;
      let declaredClass = 0;
      for (const code of codes) {
        const a = Number(code[code.length - 2]);
        const b = Number(code[code.length - 1]);
        if (a === b) continue;
        const swapped = `${code.slice(0, -2)}${b}${a}`;
        if (Math.abs(a - b) === 5) { declaredClass++; continue; } // hạng ±5 đã tuyên bố — ca lọt duy nhất được phép
        checked++;
        expect(ok(swapped), `${label} edge transposition ${code} -> ${swapped} must fail the checksum`).toBe(false);
        expect(roster.has(swapped), `${label} edge transposition ${code} -> ${swapped} must not be a roster code`).toBe(false);
      }
      // eslint-disable-next-line no-console
      console.log(`[CAM-0 checksum] ${label} roster edge pair: ${checked} non-±5 transpositions checked, 0 leaks; ${declaredClass} in the declared ±5 class`);
      expect(checked).toBeGreaterThan(0);
    };
    checkEdge(Array.from({ length: 999 }, (_, i) => studentCodeForIndex(i)), studentCodeChecksumOk, 'student codes');
    checkEdge(Array.from({ length: 5_000 }, (_, i) => sbdCodeForIndex(i)), sbdCodeChecksumOk, 'SBD codes');
  });
});
