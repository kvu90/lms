import { describe, expect, it } from 'vitest';
import { canTransition, gradeAnswer, usageState, DeferredFeedbackBehaviour } from './question-engine';

/**
 * Engine domain tests. Oracle: question/engine/tests/
 * questionusagebyactivity_test.php (usage groups attempts; deferred
 * behaviour stores responses and grades at finish) and the question_state
 * machine in question/engine — translated to the core's data-level qtypes.
 */
describe('question engine domain (Moodle questionusagebyactivity_test)', () => {
  it('state machine: notstarted can only start; graded states are terminal', () => {
    expect(canTransition('notstarted', 'todo')).toBe(true);
    expect(canTransition('notstarted', 'gradedright')).toBe(false);
    expect(canTransition('todo', 'complete')).toBe(true);
    expect(canTransition('complete', 'gradedright')).toBe(true);
    expect(canTransition('gradedright', 'todo')).toBe(false);
  });

  it('deferredfeedback: submitting records complete/incomplete without grading; grading happens at finish', () => {
    const b = new DeferredFeedbackBehaviour();
    expect(b.stateAfterSubmit('true')).toBe('complete');
    expect(b.stateAfterSubmit('')).toBe('incomplete');
    expect(b.stateAfterSubmit(null)).toBe('incomplete');
    expect(b.gradeAtFinish('truefalse', { correct: true }, null)).toBeNull(); // unanswered → gaveup
  });

  it('truefalse grading follows the version answer data', () => {
    expect(gradeAnswer('truefalse', { correct: true }, 'true').state).toBe('gradedright');
    expect(gradeAnswer('truefalse', { correct: false }, 'true').state).toBe('gradedwrong');
    expect(gradeAnswer('truefalse', { correct: false }, 'false').fraction).toBe(1);
  });

  it('shortanswer grading is trimmed and case-insensitive by default, exact when casesensitive', () => {
    const data = { answers: ['Paris'] };
    expect(gradeAnswer('shortanswer', data, '  paris ').fraction).toBe(1);
    expect(gradeAnswer('shortanswer', data, 'London').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', { answers: ['Paris'], casesensitive: true }, 'paris').fraction).toBe(0);
    expect(gradeAnswer('shortanswer', { answers: ['Paris'], casesensitive: true }, 'Paris').fraction).toBe(1);
  });

  it('usage state rolls up: finished only when every attempt is finished', () => {
    expect(usageState(['notstarted', 'notstarted'])).toBe('notstarted');
    expect(usageState(['todo', 'gradedright'])).toBe('inprogress');
    expect(usageState(['gradedright', 'gaveup'])).toBe('finished');
  });
});
