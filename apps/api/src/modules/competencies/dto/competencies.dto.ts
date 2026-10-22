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
  frameworkExportSchema,
  gradeUserCompetencySchema,
  linkCompetencySchema,
  numericValueSchema,
  setCompetencyRuleSchema,
  type AddCompetencyEvidence,
  type AddTemplateCohort,
  type AddTemplateCompetency,
  type CompetencyNote,
  type CompetencyReviewDecision,
  type CreateCompetency,
  type CreateCompetencyFramework,
  type CreateLearningPlan,
  type CreateLearningPlanTemplate,
  type FrameworkExport,
  type GradeUserCompetency,
  type LinkCompetency,
  type NumericValue,
  type SetCompetencyRule,
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
  frameworkExportSchema,
  gradeUserCompetencySchema,
  linkCompetencySchema,
  numericValueSchema,
  setCompetencyRuleSchema,
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
export type SetCompetencyRuleDto = SetCompetencyRule;
export type FrameworkExportDto = FrameworkExport;
