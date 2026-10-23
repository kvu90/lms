import { describe, expect, it } from 'vitest';
import { canTransition, compareStringWithWildcard, gradeAnswer, usageState, DeferredFeedbackBehaviour, type GradingData } from './question-engine';

/**
 * Engine domain tests. Oracles (Moodle, bản main đọc 23/10/2026):
 *  - question/engine/tests/questionusagebyactivity_test.php (usage groups
 *    attempts; deferred behaviour stores responses and grades at finish)
 *    và máy trạng thái question/engine/states.php (graded_state_for_fraction).
 *  - question/type/truefalse/tests/question_test.php (grade_response).
 *  - question/type/shortanswer/tests/question_test.php
 *    (test_compare_string_with_wildcard) + chiến lược khớp đầu tiên
 *    question_first_matching_answer_grading_strategy (questionbase.php).
 *  - question/type/multichoice/tests/question_single_test.php và
 *    question_multi_test.php (grade_response: single lấy fraction của đáp
 *    án đã chọn; multi cộng fraction rồi kẹp [0, 1]).
 *  - question/type/essay/question.php: essay không có grade_response tự
 *    động — attempt về needsgrading chờ chấm tay.
 */
describe('question engine domain (Moodle questionusagebyactivity_test)', () => {
  it('state machine: notstarted can only start; graded states are terminal', () => {
    expect(canTransition('notstarted', 'todo')).toBe(true);
    expect(canTransition('notstarted', 'gradedright')).toBe(false);
    expect(canTransition('todo', 'complete')).toBe(true);
    expect(canTransition('complete', 'gradedright')).toBe(true);
    expect(canTransition('complete', 'needsgrading')).toBe(true);
    expect(canTransition('gradedright', 'todo')).toBe(false);
    expect(canTransition('needsgrading', 'gradedright')).toBe(false);
  });

  it('deferredfeedback: submitting records complete/incomplete without grading; grading happens at finish', () => {
    const b = new DeferredFeedbackBehaviour();
    expect(b.stateAfterSubmit('true')).toBe('complete');
    expect(b.stateAfterSubmit('')).toBe('incomplete');
    expect(b.stateAfterSubmit(null)).toBe('incomplete');
    const tf: GradingData = {
      answers: [
        { id: 'a-true', text: 'True', fraction: 1 },
        { id: 'a-false', text: 'False', fraction: 0 },
      ],
      truefalse: { trueanswerId: 'a-true', falseanswerId: 'a-false' },
    };
    expect(b.gradeAtFinish('truefalse', tf, null)).toBeNull(); // unanswered → gaveup
  });

  it('truefalse grading: the side whose answer row carries fraction 1 is correct', () => {
    const correctTrue: GradingData = {
      answers: [
        { id: 't', text: 'True', fraction: 1 },
        { id: 'f', text: 'False', fraction: 0 },
      ],
      truefalse: { trueanswerId: 't', falseanswerId: 'f' },
    };
    const correctFalse: GradingData = {
      answers: [
        { id: 't', text: 'True', fraction: 0 },
        { id: 'f', text: 'False', fraction: 1 },
      ],
      truefalse: { trueanswerId: 't', falseanswerId: 'f' },
    };
    expect(gradeAnswer('truefalse', correctTrue, 'true').state).toBe('gradedright');
    expect(gradeAnswer('truefalse', correctFalse, 'true').state).toBe('gradedwrong');
    expect(gradeAnswer('truefalse', correctFalse, 'false').fraction).toBe(1);
    expect(gradeAnswer('truefalse', correctTrue, 'true').rightAnswer).toBe('True');
  });

  it('shortanswer wildcard compare follows Moodle test_compare_string_with_wildcard cases', () => {
    // Case sensitive literal.
    expect(compareStringWithWildcard('Frog', 'Frog', false)).toBe(true);
    expect(compareStringWithWildcard('Frog', 'frog', false)).toBe(false);
    expect(compareStringWithWildcard('   Frog   ', 'Frog', false)).toBe(true);
    expect(compareStringWithWildcard('Frogs', 'Frog', false)).toBe(false);
    // Case insensitive.
    expect(compareStringWithWildcard('Frog', 'frog', true)).toBe(true);
    expect(compareStringWithWildcard('   FROG   ', 'Frog', true)).toBe(true);
    // Wildcards.
    expect(compareStringWithWildcard('Frog', 'F*og', false)).toBe(true);
    expect(compareStringWithWildcard('Fog', 'F*og', false)).toBe(true);
    expect(compareStringWithWildcard('   Fat dog   ', 'F*og', false)).toBe(true);
    expect(compareStringWithWildcard('Frogs', 'F*og', false)).toBe(false);
    expect(compareStringWithWildcard('Fg', 'F*og', false)).toBe(false);
    expect(compareStringWithWildcard('frog', 'F*og', false)).toBe(false);
    expect(compareStringWithWildcard('Frog', 'F*og', true)).toBe(true);
    // Escaped star is a literal star.
    expect(compareStringWithWildcard('a*b', 'a\\*b', false)).toBe(true);
    expect(compareStringWithWildcard('axb', 'a\\*b', false)).toBe(false);
  });

  it('shortanswer grading: first matching answer wins; usecase toggles case sensitivity', () => {
    const data: GradingData = {
      answers: [
        { id: '1', text: 'frog', fraction: 0.5 },
        { id: '2', text: 'frog', fraction: 1 },
      ],
      shortanswer: { usecase: false },
    };
    // Đáp án khớp đầu tiên (fraction 0.5) quyết định, không phải đáp án tốt nhất.
    expect(gradeAnswer('shortanswer', data, 'FROG').fraction).toBe(0.5);
    expect(gradeAnswer('shortanswer', data, 'FROG').state).toBe('gradedpartial');
    expect(gradeAnswer('shortanswer', data, 'toad').fraction).toBe(0);
    const sensitive: GradingData = {
      answers: [{ id: '1', text: 'Paris', fraction: 1 }],
      shortanswer: { usecase: true },
    };
    expect(gradeAnswer('shortanswer', sensitive, 'paris').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', sensitive, 'Paris').fraction).toBe(1);
    expect(gradeAnswer('shortanswer', sensitive, 'Paris').rightAnswer).toBe('Paris');
  });

  it('multichoice single: fraction of the chosen answer (question_single_test semantics)', () => {
    const data: GradingData = {
      answers: [
        { id: 'a', text: 'A', fraction: 1 },
        { id: 'b', text: 'B', fraction: 0 },
        { id: 'c', text: 'C', fraction: 0.5 },
      ],
      multichoice: { single: true },
    };
    expect(gradeAnswer('multichoice', data, 'a')).toMatchObject({ fraction: 1, state: 'gradedright' });
    expect(gradeAnswer('multichoice', data, 'b')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'c')).toMatchObject({ fraction: 0.5, state: 'gradedpartial' });
    expect(gradeAnswer('multichoice', data, 'missing-id')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'a').rightAnswer).toBe('A');
  });

  it('multichoice multiple: fractions are summed and clamped to [0, 1] (question_multi_test)', () => {
    // Nguyên văn fixture của Moodle (test_question_maker::make_a_multichoice_multi_question):
    // A = 0.5, B = -1, C = 0.5, D = -1.
    const data: GradingData = {
      answers: [
        { id: 'a', text: 'A', fraction: 0.5 },
        { id: 'b', text: 'B', fraction: -1 },
        { id: 'c', text: 'C', fraction: 0.5 },
        { id: 'd', text: 'D', fraction: -1 },
      ],
      multichoice: { single: false },
    };
    expect(gradeAnswer('multichoice', data, 'a,c')).toMatchObject({ fraction: 1, state: 'gradedright' });
    expect(gradeAnswer('multichoice', data, 'a')).toMatchObject({ fraction: 0.5, state: 'gradedpartial' });
    expect(gradeAnswer('multichoice', data, 'a,b,c')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'b')).toMatchObject({ fraction: 0, state: 'gradedwrong' });
    expect(gradeAnswer('multichoice', data, 'a,c').rightAnswer).toBe('A, C');
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
