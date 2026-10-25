/**
 * BỘ ẢNH KIỂM CHỨNG MÔ PHỎNG của CAM-0 (issue #112, tiêu chí nghiệm thu
 * Phần 4.2 của hồ sơ research): phiếu dựng từ chính template hệ thống,
 * tô theo kịch bản, "chụp" mô phỏng (lệch phối cảnh + nhiễu + gradient
 * sáng + mờ nhẹ) rồi đọc bằng đúng engine sản xuất. Các ngưỡng khẳng
 * định trong file này là tiêu chí nghiệm thu cứng của issue:
 *  - độ chính xác đọc ô ≥ 99,5% trên ảnh đạt cổng chất lượng;
 *  - 100% ca mơ hồ (tô mờ, dấu ✓, tô hai ô, tẩy xoá) vào hàng chờ —
 *    không ca nào bị đoán;
 *  - QR định danh đúng 100%;
 *  - mã tô sai bị phát hiện 100% (số kiểm tra hỏng → không gán nhầm).
 */
import { describe, expect, it } from 'vitest';
import { computeSheetGeometry, sbdCodeForIndex, studentCodeForIndex } from './sheet-layout';
import { processSheetImage } from './omr';
import { renderSheetRgba, seededRandom, simulatePhoto, type SlotFill } from './sheet-render';

const OPTION_COUNTS_40 = Array.from({ length: 40 }, (_, i) => (i % 7 === 3 ? 2 : 4));
const LONG = { timeout: 600_000 };

describe('CAM-0 simulated acceptance set', () => {
  it('accuracy: clean filled sheets read ≥99.5% of bubbles correctly, QR 100%', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    let totalQuestions = 0, correctQuestions = 0, ambiguousOnClean = 0;
    let totalCells = 0, correctCells = 0;
    let qrOk = 0;
    const SHEETS = 10;
    for (let s = 0; s < SHEETS; s++) {
      const rand = seededRandom(1000 + s);
      const fills = new Map<number, SlotFill>();
      const truth = new Map<number, number | null>();
      geometry.rows.forEach((row) => {
        const optionCount = row.centers.length;
        if (rand() < 0.18) { truth.set(row.slot, null); return; } // để trống ~18%
        const choice = Math.floor(rand() * optionCount);
        fills.set(row.slot, { choice, style: 'full' });
        truth.set(row.slot, choice);
      });
      const qrText = `LMSQ1|quiz-${s}|A|user-${s}|chk${s}`;
      const sheet = renderSheetRgba({ geometry, qrText, bubbleCode: null, fills });
      const photo = simulatePhoto(sheet, { seed: 5000 + s, blurPasses: s % 3 === 0 ? 1 : 0 });
      const result = processSheetImage(photo, geometry);
      expect(result.qualityOk, `sheet ${s} should pass quality gate: ${result.qualityReasons.join(',')}`).toBe(true);
      if (result.qrText === qrText) qrOk++;
      for (const reading of result.readings) {
        totalQuestions++;
        const expected = truth.get(reading.slot) ?? null;
        if (reading.state === 'ambiguous') { ambiguousOnClean++; continue; }
        if (reading.chosen === expected) correctQuestions++;
        const expectedCells = reading.densities.map((_, k) => (expected === k ? 1 : 0));
        reading.densities.forEach((d, k) => {
          totalCells++;
          const cellFilled = d >= 0.42;
          const cellBlank = d <= 0.16;
          if ((expectedCells[k] === 1 && cellFilled) || (expectedCells[k] === 0 && cellBlank)) correctCells++;
        });
      }
    }
    const questionAccuracy = correctQuestions / totalQuestions;
    const cellAccuracy = correctCells / totalCells;
    // eslint-disable-next-line no-console
    console.log(`[CAM-0 bench] clean set: questions ${correctQuestions}/${totalQuestions} (${(questionAccuracy * 100).toFixed(2)}%), cells ${correctCells}/${totalCells} (${(cellAccuracy * 100).toFixed(2)}%), ambiguous-on-clean ${ambiguousOnClean}, QR ${qrOk}/${SHEETS}`);
    expect(cellAccuracy).toBeGreaterThanOrEqual(0.995);
    expect(questionAccuracy).toBeGreaterThanOrEqual(0.995);
    expect(qrOk).toBe(SHEETS);
  });

  it('ambiguity: light fills, check marks, double fills and erasures are ALL captured, none guessed', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    const special: SlotFill[] = [
      { choice: 0, style: 'light' },
      { choice: 1, style: 'check' },
      { choice: 0, style: 'full', secondChoice: 2 },
      { choice: 1, style: 'erased' },
    ];
    let checked = 0;
    for (let round = 0; round < special.length; round++) {
      const fills = new Map<number, SlotFill>();
      // 8 câu đặc biệt mỗi phiếu, còn lại tô chuẩn để phiếu giống thật.
      // secondChoice phải nằm trong số ô của câu (câu đúng/sai chỉ có 2 ô).
      for (let k = 0; k < 8; k++) {
        const row = geometry.rows[k]!;
        const base = special[round]!;
        const choice = (base.choice + k) % row.centers.length;
        const fill: SlotFill = { choice, style: base.style };
        if (base.secondChoice !== undefined) fill.secondChoice = (choice + 1) % row.centers.length;
        fills.set(k + 1, fill);
      }
      for (let slot = 9; slot <= 40; slot++) fills.set(slot, { choice: slot % 4, style: 'full' });
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: '1018', fills });
      const photo = simulatePhoto(sheet, { seed: 9000 + round });
      const result = processSheetImage(photo, geometry);
      expect(result.qualityOk).toBe(true);
      for (let slot = 1; slot <= 8; slot++) {
        const reading = result.readings.find((r) => r.slot === slot)!;
        checked++;
        expect(reading.state, `round ${round} slot ${slot} (${special[round]!.style}) must be ambiguous, got ${reading.state} chosen=${reading.chosen}`).toBe('ambiguous');
        expect(reading.chosen).toBeNull();
      }
    }
    expect(checked).toBe(32);
  });

  it('identity: bubble codes read exactly; a single wrong digit is always detected', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    const fills = new Map<number, SlotFill>();
    for (let slot = 1; slot <= 40; slot++) fills.set(slot, { choice: slot % 4, style: 'full' });
    // Mã đúng cho 5 học sinh khác nhau.
    for (const index of [0, 4, 17, 42, 120]) {
      const code = studentCodeForIndex(index);
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: code, fills });
      const photo = simulatePhoto(sheet, { seed: 7000 + index });
      const result = processSheetImage(photo, geometry);
      expect(result.bubbleCode?.code).toBe(code);
      expect(result.bubbleCode?.checksumOk).toBe(true);
    }
    // Tô sai đúng 1 số (số kiểm tra giữ nguyên của mã đúng) → phải bị phát hiện 100%.
    for (const index of [3, 25, 88]) {
      const good = studentCodeForIndex(index);
      const wrongDigit = (Number(good[1]) + 3) % 10;
      const tampered = `${good[0]}${wrongDigit}${good[2]}${good[3]}`;
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: tampered, fills });
      const photo = simulatePhoto(sheet, { seed: 8000 + index });
      const result = processSheetImage(photo, geometry);
      const accepted = result.bubbleCode !== null && result.bubbleCode.checksumOk;
      expect(accepted, `tampered code ${tampered} must not validate`).toBe(false);
    }
  });

  it('quality gate: sheets with a missing fiducial or heavy blur are rejected', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    const fills = new Map<number, SlotFill>();
    for (let slot = 1; slot <= 40; slot++) fills.set(slot, { choice: 1, style: 'full' });
    const sheet = renderSheetRgba({ geometry, qrText: 'LMSQ1|q|A|u|c', bubbleCode: null, fills });
    const blurred = processSheetImage(simulatePhoto(sheet, { seed: 31337, blurPasses: 8 }), geometry);
    expect(blurred.qualityOk).toBe(false);
    expect(blurred.qualityReasons).toContain('blurry');
    // Che mất một fiducial bằng mảng trắng lớn ở góc.
    const broken = renderSheetRgba({ geometry, qrText: 'LMSQ1|q|A|u|c', bubbleCode: null, fills });
    for (let y = 0; y < 260; y++) {
      for (let x = 0; x < 260; x++) {
        const i = (y * broken.width + x) * 4;
        broken.data[i] = 250; broken.data[i + 1] = 250; broken.data[i + 2] = 250;
      }
    }
    const missing = processSheetImage(simulatePhoto(broken, { seed: 4242 }), geometry);
    expect(missing.qualityOk).toBe(false);
    expect(missing.qualityReasons).toContain('missing_fiducials');
  });
});

/**
 * Mở rộng cho lát sửa flow (phiếu DÙNG CHUNG + mã đề + mã SBD 8 số):
 * lưới mã đề đọc bằng đúng luật của lưới mã học sinh — chắc chắn mới
 * kết luận, mơ hồ thì null (hàng chờ), tô mã nào đọc đúng mã đó (hệ
 * thống không "sửa" mã đề về mã gần nhất); mã thí sinh 8 số đọc đúng
 * và bắt sai một chữ số 100% như mã 4 số.
 */
describe('CAM-0 shared-sheet flow (variant grid + SBD codes)', () => {
  const FILLS_40 = () => {
    const fills = new Map<number, SlotFill>();
    for (let slot = 1; slot <= 40; slot++) fills.set(slot, { choice: slot % 4, style: 'full' });
    return fills;
  };

  it('variant grid: a cleanly bubbled 4-digit exam code reads exactly', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    for (const [seed, variant] of [[1101, '1001'], [1102, '0241'], [1103, '9876']] as const) {
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: null, variantCode: variant, fills: FILLS_40() });
      const result = processSheetImage(simulatePhoto(sheet, { seed }), geometry);
      expect(result.qualityOk).toBe(true);
      expect(result.variantCode?.code).toBe(variant);
    }
  });

  it('variant grid: one lightly-bubbled digit makes the whole code uncertain — never guessed', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    for (const lightDigit of [0, 2, 3]) {
      const sheet = renderSheetRgba({
        geometry, qrText: null, bubbleCode: null, variantCode: '1001', variantLightDigit: lightDigit, fills: FILLS_40(),
      });
      const result = processSheetImage(simulatePhoto(sheet, { seed: 1200 + lightDigit }), geometry);
      expect(result.qualityOk).toBe(true);
      expect(result.variantCode, `light digit ${lightDigit} must not be guessed`).toBeNull();
    }
    // Không tô cột nào của lưới mã đề → cũng null (phiếu cá nhân hoá/không dùng mã đề).
    const blank = renderSheetRgba({ geometry, qrText: null, bubbleCode: null, variantCode: '', fills: FILLS_40() });
    const blankResult = processSheetImage(simulatePhoto(blank, { seed: 1299 }), geometry);
    expect(blankResult.variantCode).toBeNull();
  });

  it('variant grid: a wrong-but-clean code reads as-is (routing layer, not the engine, rejects it)', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40);
    const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: null, variantCode: '9999', fills: FILLS_40() });
    const result = processSheetImage(simulatePhoto(sheet, { seed: 1301 }), geometry);
    expect(result.variantCode?.code).toBe('9999');
  });

  it('SBD identity: 8-digit codes read exactly; a single wrong digit is always detected', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40, 8);
    expect(geometry.codeDigits).toBe(8);
    const fills = FILLS_40();
    for (const index of [0, 4, 17, 42, 120, 999]) {
      const code = sbdCodeForIndex(index);
      expect(code).toMatch(/^\d{8}$/);
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: code, fills });
      const result = processSheetImage(simulatePhoto(sheet, { seed: 17000 + index }), geometry);
      expect(result.bubbleCode?.code).toBe(code);
      expect(result.bubbleCode?.checksumOk).toBe(true);
    }
    // Tô sai đúng 1 số ở các vị trí khác nhau (kể cả số kiểm tra) → phát hiện 100%.
    for (const [index, pos] of [[3, 0], [25, 3], [88, 6], [7, 7]] as const) {
      const good = sbdCodeForIndex(index);
      const tampered = `${good.slice(0, pos)}${(Number(good[pos]) + 3) % 10}${good.slice(pos + 1)}`;
      const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: tampered, fills });
      const result = processSheetImage(simulatePhoto(sheet, { seed: 18000 + index * 10 + pos }), geometry);
      const accepted = result.bubbleCode !== null && result.bubbleCode.checksumOk;
      expect(accepted, `tampered SBD ${tampered} must not validate`).toBe(false);
    }
  });

  it('shared sheet end-to-end: SBD code + variant code + answers all read from one photo', LONG, () => {
    const geometry = computeSheetGeometry(OPTION_COUNTS_40, 8);
    const fills = new Map<number, SlotFill>();
    const truth = new Map<number, number | null>();
    geometry.rows.forEach((row) => {
      const choice = row.slot % row.centers.length;
      fills.set(row.slot, { choice, style: 'full' });
      truth.set(row.slot, choice);
    });
    const code = sbdCodeForIndex(23);
    const sheet = renderSheetRgba({ geometry, qrText: null, bubbleCode: code, variantCode: '1002', fills });
    const result = processSheetImage(simulatePhoto(sheet, { seed: 19001 }), geometry);
    expect(result.qualityOk).toBe(true);
    expect(result.bubbleCode).toEqual({ code, checksumOk: true });
    expect(result.variantCode?.code).toBe('1002');
    for (const reading of result.readings) {
      expect(reading.state).toBe('filled');
      expect(reading.chosen).toBe(truth.get(reading.slot));
    }
  });
});
