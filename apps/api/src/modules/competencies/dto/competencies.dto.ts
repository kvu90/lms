import {
  addCompetencyEvidenceSchema,
  addTemplateCohortSchema,
  addTemplateCompetencySchema,
  competencyNoteSchema,
  competencyReviewDecisionSchema,
  createCompetencyFrameworkSchema,
  createCompetencySchema,
  createLearningPlanSchema,
  createLearningPlanTemplateSchema,
  gradeUserCompetencySchema,
  linkCompetencySchema,
  numericValueSchema,
  type AddCompetencyEvidence,
  type AddTemplateCohort,
  type AddTemplateCompetency,
  type CompetencyNote,
  type CompetencyReviewDecision,
  type CreateCompetency,
  type CreateCompetencyFramework,
  type CreateLearningPlan,
  type CreateLearningPlanTemplate,
  type GradeUserCompetency,
  type LinkCompetency,
  type NumericValue,
} from '@lms/contracts';

/**
 * Validation của Competencies dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  addCompetencyEvidenceSchema,
  addTemplateCohortSchema,
  addTemplateCompetencySchema,
  competencyNoteSchema,
  competencyReviewDecisionSchema,
  createCompetencyFrameworkSchema,
  createCompetencySchema,
  createLearningPlanSchema,
  createLearningPlanTemplateSchema,
  gradeUserCompetencySchema,
  linkCompetencySchema,
  numericValueSchema,
};
export type CreateFrameworkDto = CreateCompetencyFramework;
export type CreateCompetencyDto = CreateCompetency;
export type LinkCompetencyDto = LinkCompetency;
export type CreateTemplateDto = CreateLearningPlanTemplate;
export type AddTemplateCompetencyDto = AddTemplateCompetency;
export type AddTemplateCohortDto = AddTemplateCohort;
export type CreatePlanDto = CreateLearningPlan;
export type AddEvidenceDto = AddCompetencyEvidence;
export type GradeUsercompDto = GradeUserCompetency;
export type ReviewDecisionDto = CompetencyReviewDecision;
export type NoteDto = CompetencyNote;
export type NumericDto = NumericValue;
