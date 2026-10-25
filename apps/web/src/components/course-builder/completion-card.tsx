import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { CourseContent } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { CardDescription } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';

type CriterionDraft = { criteriaType: string; moduleInstance: string; date: string };
type Section = CourseContent['sections'][number];

interface CompletionCardProps {
  canManageCompletion: boolean;
  criteriaMethod: number;
  setCriteriaMethod: Dispatch<SetStateAction<number>>;
  criteriaDraft: CriterionDraft[];
  setCriteriaDraft: Dispatch<SetStateAction<CriterionDraft[]>>;
  sections: Section[];
  onSaveCriteria: (event: FormEvent) => void;
  onRecalculate: () => void;
  selectClass: string;
}

/** Thẻ tiêu chí hoàn thành khoá của trang Xây dựng khoá (chỉ hiện khi có quyền completion:manage). */
export function CompletionCard({
  canManageCompletion, criteriaMethod, setCriteriaMethod, criteriaDraft, setCriteriaDraft,
  sections, onSaveCriteria, onRecalculate, selectClass,
}: CompletionCardProps) {
  const { t } = useTranslation('app');
  const saveCriteria = onSaveCriteria;
  const recalculateCompletion = onRecalculate;
  return (
    <>
      {canManageCompletion ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('completionCriteriaTitle')}</CardTitle>
            <CardDescription>{t('completionCriteriaDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void saveCriteria(e)} className="space-y-3" data-testid="completion-criteria">
              <div className="space-y-2">
                <Label htmlFor="criteria-method">{t('completionMethod')}</Label>
                <select
                  id="criteria-method"
                  aria-label={t('completionMethod')}
                  className={selectClass}
                  value={criteriaMethod}
                  onChange={(e) => setCriteriaMethod(Number(e.target.value))}
                >
                  <option value={1}>{t('completionMethodAll')}</option>
                  <option value={2}>{t('completionMethodAny')}</option>
                </select>
              </div>
              {criteriaDraft.length === 0 ? <p className="text-sm text-muted-foreground">{t('noCriteria')}</p> : null}
              {criteriaDraft.map((criterion, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`criterion-type-${index}`}>{t('criterionType')}</Label>
                    <select
                      id={`criterion-type-${index}`}
                      className={selectClass}
                      value={criterion.criteriaType}
                      onChange={(e) =>
                        setCriteriaDraft((prev) =>
                          prev.map((c, i) =>
                            i === index
                              ? {
                                  ...c,
                                  criteriaType: e.target.value,
                                  moduleInstance:
                                    e.target.value === 'module' && !c.moduleInstance
                                      ? (sections.flatMap((s) => s.modules)[0]?.id ?? '')
                                      : c.moduleInstance,
                                }
                              : c,
                          ),
                        )
                      }
                    >
                      <option value="module">{t('criterionTypeModule')}</option>
                      <option value="date">{t('criterionTypeDate')}</option>
                      <option value="grade">{t('criterionTypeGrade')}</option>
                    </select>
                  </div>
                  {criterion.criteriaType === 'module' ? (
                    <div className="space-y-1">
                      <Label htmlFor={`criterion-module-${index}`}>{t('criterionModule')}</Label>
                      <select
                        id={`criterion-module-${index}`}
                        className={selectClass}
                        value={criterion.moduleInstance}
                        onChange={(e) =>
                          setCriteriaDraft((prev) => prev.map((c, i) => (i === index ? { ...c, moduleInstance: e.target.value } : c)))
                        }
                      >
                        {sections
                          .flatMap((s) => s.modules)
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name || m.component}
                            </option>
                          ))}
                      </select>
                    </div>
                  ) : null}
                  {criterion.criteriaType === 'date' ? (
                    <div className="space-y-1">
                      <Label htmlFor={`criterion-date-${index}`}>{t('criterionDate')}</Label>
                      <Input
                        id={`criterion-date-${index}`}
                        type="date"
                        value={criterion.date}
                        onChange={(e) =>
                          setCriteriaDraft((prev) => prev.map((c, i) => (i === index ? { ...c, date: e.target.value } : c)))
                        }
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => setCriteriaDraft((prev) => prev.filter((_, i) => i !== index))}
                  >
                    {t('removeCriterion')}
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCriteriaDraft((prev) => [...prev, { criteriaType: 'grade', moduleInstance: '', date: '' }])}
                >
                  {t('addCriterion')}
                </Button>
                <Button type="submit">{t('saveCriteria')}</Button>
                <Button type="button" variant="outline" onClick={() => void recalculateCompletion()}>
                  {t('recalculateCompletion')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
