/**
 * Unit test cho gói phiên bản bất biến (issue #585): chuẩn hoá JSON
 * và checksum SHA-256 phải ổn định và phát hiện được thay đổi nội dung.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeJson,
  checksumPackage,
  packageValidationError,
  verifyPackageChecksum,
  type SystemQuestionPackage,
} from './system-bank-package';

function samplePackage(): SystemQuestionPackage {
  return {
    questionText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2 + 2 = ?' }] }] },
    generalFeedback: null,
    stimulusContent: null,
    answers: [
      { answer: { type: 'doc', content: [] }, isCorrect: false, feedback: null, sortOrder: 0 },
      { answer: { type: 'doc', content: [] }, isCorrect: true, feedback: null, sortOrder: 1 },
    ],
    answerKey: null,
    options: { choiceCount: 2 },
    outcomes: [{ outcomeId: '11111111-1111-7111-8111-111111111111', cognitiveLevel: 'hieu' }],
  };
}

describe('Gói phiên bản ngân hàng hệ thống — chuẩn hoá JSON', () => {
  it('sắp xếp khoá đệ quy nên cùng nội dung khác thứ tự khoá cho cùng một chuỗi', () => {
    expect(canonicalizeJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(canonicalizeJson([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });

  it('mảng giữ nguyên thứ tự — đổi thứ tự đáp án là đổi gói', () => {
    expect(canonicalizeJson([1, 2])).not.toBe(canonicalizeJson([2, 1]));
  });
});

describe('Gói phiên bản ngân hàng hệ thống — checksum', () => {
  it('cùng một gói luôn cho cùng một checksum 64 ký tự hex', () => {
    const pkg = samplePackage();
    const first = checksumPackage(pkg);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(checksumPackage(pkg)).toBe(first);
  });

  it('đổi bất kỳ trường nào trong gói cũng đổi checksum', () => {
    const base = checksumPackage(samplePackage());
    const changedAnswer = samplePackage();
    changedAnswer.answers[1]!.isCorrect = false;
    expect(checksumPackage(changedAnswer)).not.toBe(base);
    const changedOutcome = samplePackage();
    changedOutcome.outcomes[0]!.cognitiveLevel = 'biet';
    expect(checksumPackage(changedOutcome)).not.toBe(base);
    const changedOrder = samplePackage();
    changedOrder.answers.reverse();
    expect(checksumPackage(changedOrder)).not.toBe(base);
  });

  it('kiểm chứng chấp nhận gói nguyên vẹn và từ chối gói đã bị sửa', () => {
    const pkg = samplePackage();
    const checksum = checksumPackage(pkg);
    expect(verifyPackageChecksum(pkg, checksum)).toBe(true);
    const tampered = samplePackage();
    tampered.options = { choiceCount: 3 };
    expect(verifyPackageChecksum(tampered, checksum)).toBe(false);
  });
});

describe('Gói phiên bản ngân hàng hệ thống — luật đáp án theo dạng câu', () => {
  function answers(count: number, correct: number): SystemQuestionPackage['answers'] {
    return Array.from({ length: count }, (_, i) => ({
      answer: { type: 'doc', content: [] },
      isCorrect: i < correct,
      feedback: null,
      sortOrder: i,
    }));
  }

  function pkgWith(answersList: SystemQuestionPackage['answers']): SystemQuestionPackage {
    const pkg = samplePackage();
    pkg.answers = answersList;
    return pkg;
  }

  it('multichoice: đúng 4 lựa chọn và đúng 1 đáp án đúng mới hợp lệ', () => {
    expect(packageValidationError('multichoice', pkgWith(answers(4, 1)))).toBeNull();
    expect(packageValidationError('multichoice', pkgWith(answers(3, 1)))).toMatch(/exactly 4/);
    expect(packageValidationError('multichoice', pkgWith(answers(4, 0)))).toMatch(/exactly 1 correct/);
    expect(packageValidationError('multichoice', pkgWith(answers(4, 2)))).toMatch(/exactly 1 correct/);
  });

  it('truefalse TF-A và essay: không mang dòng đáp án', () => {
    expect(packageValidationError('truefalse', pkgWith([]))).toBeNull();
    expect(packageValidationError('truefalse', pkgWith(answers(2, 1)))).toMatch(/do not carry answer rows/);
    expect(packageValidationError('essay', pkgWith([]))).toBeNull();
    expect(packageValidationError('essay', pkgWith(answers(1, 1)))).toMatch(/do not carry answer rows/);
  });

  it('shortanswer: ít nhất 1 đáp án và mọi dòng đều là đáp án được chấp nhận', () => {
    expect(packageValidationError('shortanswer', pkgWith(answers(2, 2)))).toBeNull();
    expect(packageValidationError('shortanswer', pkgWith([]))).toMatch(/at least 1/);
    expect(packageValidationError('shortanswer', pkgWith(answers(2, 1)))).toMatch(/must all be accepted/);
  });

  it('dạng câu ngoài 4 dạng đã chốt bị coi là gói lỗi', () => {
    expect(packageValidationError('matching', samplePackage())).toMatch(/unsupported question type/);
  });
});
