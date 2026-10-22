/**
 * Question engine domain — PURE (no Nest, no DB), report §2#8.
 *
 * Ported from Moodle core_question's engine semantics
 * (question/engine/tests/questionusagebyactivity_test.php: usages group
 * attempts; attempts start in `notstarted`, a deferred-feedback attempt is
 * started → answered → finished/graded, and EVERY transition is a step).
 *
 * States follow Moodle `question_state` names (subset the core supports):
 *   notstarted → todo → complete | incomplete → gradedright | gradedpartial
 *   | gradedwrong; finishing an unanswered attempt ⇒ gaveup.
 *
 * Behaviours are an internal EXTENSION POINT (interface + registry in the
 * service). `deferredfeedback` is the only behaviour shipped in core:
 * responses are stored as steps and graded only when the usage finishes,
 * against the answer data of the PINNED question version. qtypes are
 * plugins (out of scope): the version carries generic correct-answer data
 * for the two minimal data-level types, truefalse and shortanswer.
 */

export const QUESTION_STATES = [
  'notstarted', 'todo', 'incomplete', 'complete',
  'gradedright', 'gradedpartial', 'gradedwrong', 'gaveup', 'finished',
] as const;
export type QuestionState = (typeof QUESTION_STATES)[number];

export const GRADED_STATES: QuestionState[] = ['gradedright', 'gradedpartial', 'gradedwrong'];

const TRANSITIONS: Record<string, QuestionState[]> = {
  notstarted: ['todo'],
  todo: ['complete', 'incomplete', 'gaveup', 'gradedright', 'gradedpartial', 'gradedwrong'],
  incomplete: ['complete', 'incomplete', 'gaveup', 'gradedright', 'gradedpartial', 'gradedwrong'],
  complete: ['complete', 'incomplete', 'gradedright', 'gradedpartial', 'gradedwrong'],
  gradedright: [], gradedpartial: [], gradedwrong: [], gaveup: [], finished: [],
};

export function canTransition(from: string, to: QuestionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}
export function isFinishedState(state: string): boolean {
  return GRADED_STATES.includes(state as QuestionState) || state === 'gaveup' || state === 'finished';
}

/** The generic correct-answer payload stored on a question VERSION. */
export type AnswerData =
  | { kind: 'truefalse'; correct: boolean }
  | { kind: 'shortanswer'; answers: string[]; casesensitive?: boolean }
  | Record<string, unknown>;

export interface GradeOutcome {
  fraction: number; // 0..1
  state: QuestionState; // gradedright | gradedpartial | gradedwrong
  rightAnswer: string;
}

/** Grade one response against a version's answer data. Pure and total. */
export function gradeAnswer(qtype: string, answerdata: Record<string, unknown>, response: string | null): GradeOutcome {
  if (qtype === 'truefalse') {
    const correct = answerdata.correct === true || answerdata.correct === 'true';
    const rightAnswer = correct ? 'True' : 'False';
    const given = (response ?? '').trim().toLowerCase();
    const givenBool = given === 'true' || given === '1' ? true : given === 'false' || given === '0' ? false : null;
    const fraction = givenBool !== null && givenBool === correct ? 1 : 0;
    return { fraction, state: fraction === 1 ? 'gradedright' : 'gradedwrong', rightAnswer };
  }
  if (qtype === 'shortanswer') {
    const answers = Array.isArray(answerdata.answers) ? answerdata.answers.map(String) : [];
    const caseSensitive = answerdata.casesensitive === true;
    const normalise = (s: string) => {
      const t = s.trim().replace(/\s+/g, ' ');
      return caseSensitive ? t : t.toLowerCase();
    };
    const given = normalise(response ?? '');
    const fraction = given !== '' && answers.some((a) => normalise(a) === given) ? 1 : 0;
    return { fraction, state: fraction === 1 ? 'gradedright' : 'gradedwrong', rightAnswer: answers[0] ?? '' };
  }
  // Unknown data-level type: cannot be auto-graded by the core engine.
  return { fraction: 0, state: 'gradedwrong', rightAnswer: '' };
}

/**
 * Behaviour extension point. A behaviour decides how responses move the
 * attempt state and when grading happens. deferredfeedback: submitting only
 * records the response (complete/incomplete); grading happens at finish.
 */
export interface QuestionBehaviour {
  readonly name: string;
  stateAfterSubmit(response: string | null): QuestionState;
  gradeAtFinish(qtype: string, answerdata: Record<string, unknown>, response: string | null): GradeOutcome | null;
}

export class DeferredFeedbackBehaviour implements QuestionBehaviour {
  readonly name = 'deferredfeedback';
  stateAfterSubmit(response: string | null): QuestionState {
    return response !== null && response.trim() !== '' ? 'complete' : 'incomplete';
  }
  gradeAtFinish(qtype: string, answerdata: Record<string, unknown>, response: string | null): GradeOutcome | null {
    if (response === null || response.trim() === '') return null; // → gaveup
    return gradeAnswer(qtype, answerdata, response);
  }
}

export const BEHAVIOURS: Record<string, QuestionBehaviour> = {
  deferredfeedback: new DeferredFeedbackBehaviour(),
};

/** Usage-level rollup: finished only when every started attempt reached a finished state. */
export function usageState(attemptStates: string[]): 'notstarted' | 'inprogress' | 'finished' {
  if (attemptStates.length === 0 || attemptStates.every((s) => s === 'notstarted')) return 'notstarted';
  if (attemptStates.every((s) => isFinishedState(s))) return 'finished';
  return 'inprogress';
}
