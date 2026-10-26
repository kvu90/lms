import { describe, expect, it } from 'vitest';
import { canTransition, gradeAnswer, usageState, DeferredFeedbackBehaviour, type GradingData } from './question-engine';

/**
 * Kiểm chứng engine chấm theo LUỒNG NGHIỆP VỤ của mô hình giaokhoa
 * (quyết 12:04 + điểm quyết D-2 ngày 26/10/2026, đợt port #248):
 *  - đáp án chỉ mang cờ đúng/sai `isCorrect` — KHÔNG còn tỉ trọng
 *    fraction của đáp án; chấm tự động là NHỊ PHÂN 1/0 cho cả
 *    multichoice, truefalse và shortanswer, nên `gradedpartial` không
 *    xuất phát từ chấm tự động nữa (chỉ còn từ chấm tay essay);
 *  - shortanswer khớp CHÍNH XÁC sau chuẩn hoá — đáp án mẫu chứa ký tự
 *    `*` được hiểu là ký tự thường, không phải ký tự đại diện;
 *  - máy trạng thái usage/attempt giữ ngữ nghĩa Moodle
 *    (questionusagebyactivity_test): deferred behaviour chỉ ghi nhận
 *    khi nộp, chấm khi kết thúc; trạng thái graded* suy từ fraction
 *    của ATTEMPT (điểm lượt làm) theo ngưỡng states.php.
 * Các ca dưới đây phải ĐỎ nếu nghiệp vụ bị đổi ngược (vd quay lại cộng
 * tỉ trọng từng phần hay khớp wildcard).
 */
describe('question engine domain (mô hình giaokhoa — chấm nhị phân theo isCorrect)', () => {
  it('state machine: notstarted can only start; graded states are terminal', () => {
    expect(canTransition('notstarted', 'todo')).toBe(true);
    expect(canTransition('notstarted', 'gradedright')).toBe(false);
    expect(canTransition('todo', 'complete')).toBe(true);
    expect(canTransition('complete', 'gradedright')).toBe(true);
    expect(canTransition('complete', 'needsgrading')).toBe(true);
    expect(canTransition('gradedright', 'todo')).toBe(false);
    // Chấm tay: needsgrading rời sang graded* khi người chấm cho điểm
    // (manual grading của Moodle); các đích khác vẫn bị cấm.
    expect(canTransition('needsgrading', 'gradedright')).toBe(true);
    expect(canTransition('needsgrading', 'gradedpartial')).toBe(true);
    expect(canTransition('needsgrading', 'gradedwrong')).toBe(true);
    expect(canTransition('needsgrading', 'todo')).toBe(false);
    expect(canTransition('needsgrading', 'needsgrading')).toBe(false);
  });

  it('deferredfeedback: submitting records complete/incomplete without grading; grading happens at finish', () => {
    const b = new DeferredFeedbackBehaviour();
    expect(b.stateAfterSubmit('true')).toBe('complete');
    expect(b.stateAfterSubmit('')).toBe('incomplete');
    expect(b.stateAfterSubmit(null)).toBe('incomplete');
    const tf: GradingData = {
      answers: [
        { id: 'a-true', text: 'True', isCorrect: true },
        { id: 'a-false', text: 'False', isCorrect: false },
      ],
      truefalse: { trueanswerId: 'a-true', falseanswerId: 'a-false' },
    };
    expect(b.gradeAtFinish('truefalse', tf, null)).toBeNull(); // unanswered → gaveup
  });

  it('truefalse grading: phía đúng là phía mà dòng đáp án của nó mang isCorrect', () => {
    const correctTrue: GradingData = {
      answers: [
        { id: 't', text: 'Đúng', isCorrect: true },
        { id: 'f', text: 'Sai', isCorrect: false },
      ],
      truefalse: { trueanswerId: 't', falseanswerId: 'f' },
    };
    const correctFalse: GradingData = {
      answers: [
        { id: 't', text: 'Đúng', isCorrect: false },
        { id: 'f', text: 'Sai', isCorrect: true },
      ],
      truefalse: { trueanswerId: 't', falseanswerId: 'f' },
    };
    expect(gradeAnswer('truefalse', correctTrue, 'true')).toMatchObject({ fraction: 1, state: 'gradedright' });
    expect(gradeAnswer('truefalse', correctFalse, 'true')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('truefalse', correctFalse, 'false').fraction).toBe(1);
    // Đáp án đúng hiển thị là TEXT của dòng đúng, không phải chữ cứng 'True'.
    expect(gradeAnswer('truefalse', correctTrue, 'true').rightAnswer).toBe('Đúng');
    expect(gradeAnswer('truefalse', correctFalse, 'false').rightAnswer).toBe('Sai');
  });

  it('shortanswer grading: khớp CHÍNH XÁC sau chuẩn hoá — lệch một ký tự là 0, dấu * không còn là wildcard (D-2)', () => {
    const data: GradingData = {
      answers: [
        { id: '1', text: 'Hà Nội', isCorrect: true },
        { id: '2', text: 'Ha Noi', isCorrect: true },
      ],
      shortanswer: { useCase: false },
    };
    // Không phân biệt hoa/thường khi useCase tắt; khoảng trắng hai đầu bị cắt.
    expect(gradeAnswer('shortanswer', data, 'hà nội')).toMatchObject({ fraction: 1, state: 'gradedright' });
    expect(gradeAnswer('shortanswer', data, '   Hà Nội   ').fraction).toBe(1);
    // Đáp án được chấp nhận thứ hai cũng ăn điểm trọn.
    expect(gradeAnswer('shortanswer', data, 'Ha Noi').fraction).toBe(1);
    // Lệch một ký tự → 0 điểm hẳn, không có điểm từng phần.
    expect(gradeAnswer('shortanswer', data, 'Hà Nộ')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('shortanswer', data, 'Hà Nội!').fraction).toBe(0);
    // Ký tự * trong đáp án của học sinh KHÔNG khớp như wildcard.
    expect(gradeAnswer('shortanswer', data, 'Hà *').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', data, '*').fraction).toBe(0);
    // rightAnswer hiển thị là đáp án được chấp nhận đầu tiên.
    expect(gradeAnswer('shortanswer', data, 'Ha Noi').rightAnswer).toBe('Hà Nội');
  });

  it('shortanswer grading: useCase bật thì hoa/thường phải khớp đúng', () => {
    const sensitive: GradingData = {
      answers: [{ id: '1', text: 'Paris', isCorrect: true }],
      shortanswer: { useCase: true },
    };
    expect(gradeAnswer('shortanswer', sensitive, 'paris').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', sensitive, 'Paris').fraction).toBe(1);
    expect(gradeAnswer('shortanswer', sensitive, 'Paris').rightAnswer).toBe('Paris');
  });

  it('shortanswer grading: dòng đáp án không được chấp nhận (isCorrect = false) không bao giờ ăn điểm', () => {
    const data: GradingData = {
      answers: [
        { id: '1', text: 'frog', isCorrect: false },
        { id: '2', text: 'toad', isCorrect: true },
      ],
      shortanswer: { useCase: false },
    };
    expect(gradeAnswer('shortanswer', data, 'frog').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', data, 'toad').fraction).toBe(1);
  });

  it('shortanswer numeric mode (issue #30 point 6.3.3): off = khớp chính xác thường; on = length/charset gate before matching', () => {
    const base: GradingData = {
      answers: [{ id: '1', text: '1234', isCorrect: true }, { id: '2', text: '-5,5', isCorrect: true }],
      shortanswer: { useCase: false },
    };
    // Tắt (mặc định): không có cổng số — khớp chính xác như thường.
    expect(gradeAnswer('shortanswer', base, '1234').fraction).toBe(1);
    const on: GradingData = { ...base, shortanswer: { useCase: false, numericAnswer: true } };
    expect(gradeAnswer('shortanswer', on, '1234').fraction).toBe(1); // đúng 4 ký tự
    expect(gradeAnswer('shortanswer', on, '12345').fraction).toBe(0); // quá 4 ký tự mặc định
    expect(gradeAnswer('shortanswer', on, '-5,5').fraction).toBe(1); // dấu + thập phân phẩy, 4 ký tự
    expect(gradeAnswer('shortanswer', on, '12a4').fraction).toBe(0); // ký tự lạ
    expect(gradeAnswer('shortanswer', on, '').fraction).toBe(0);
    const noSign: GradingData = { ...base, shortanswer: { useCase: false, numericAnswer: true, numericAllowSign: false } };
    expect(gradeAnswer('shortanswer', noSign, '-5,5').fraction).toBe(0);
    const longer: GradingData = { ...base, shortanswer: { useCase: false, numericAnswer: true, numericMaxLength: 6 } };
    expect(gradeAnswer('shortanswer', longer, '12345').fraction).toBe(0); // hợp lệ về dạng nhưng không khớp đáp án nào
    expect(gradeAnswer('shortanswer', { answers: [{ id: '1', text: '12345', isCorrect: true }], shortanswer: { useCase: false, numericAnswer: true, numericMaxLength: 6 } }, '12345').fraction).toBe(1);
  });

  it('multichoice grading: chọn đúng một đáp án và đó là đáp án đúng duy nhất → 1; mọi trường hợp khác → 0', () => {
    const data: GradingData = {
      answers: [
        { id: 'a', text: 'A', isCorrect: true },
        { id: 'b', text: 'B', isCorrect: false },
        { id: 'c', text: 'C', isCorrect: false },
        { id: 'd', text: 'D', isCorrect: false },
      ],
    };
    expect(gradeAnswer('multichoice', data, 'a')).toMatchObject({ fraction: 1, state: 'gradedright' });
    expect(gradeAnswer('multichoice', data, 'b')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    // Chọn nhiều đáp án (kể cả có đáp án đúng bên trong) → 0: mô hình
    // giaokhoa là chọn MỘT đáp án, không còn cộng tỉ trọng từng phần —
    // ca này phải đỏ nếu engine quay lại chấm từng phần.
    expect(gradeAnswer('multichoice', data, 'a,b')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'missing-id')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, null)).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'a').rightAnswer).toBe('A');
  });

  it('essay is never auto-graded: it lands in needsgrading with a null fraction', () => {
    const outcome = gradeAnswer('essay', { answers: [] }, 'A long student essay.');
    expect(outcome.state).toBe('needsgrading');
    expect(outcome.fraction).toBeNull();
  });

  it('usage state rolls up: finished only when every attempt is finished (needsgrading counts as finished)', () => {
    expect(usageState(['notstarted', 'notstarted'])).toBe('notstarted');
    expect(usageState(['todo', 'gradedright'])).toBe('inprogress');
    expect(usageState(['gradedright', 'gaveup'])).toBe('finished');
    expect(usageState(['gradedright', 'needsgrading'])).toBe('finished');
  });
});
