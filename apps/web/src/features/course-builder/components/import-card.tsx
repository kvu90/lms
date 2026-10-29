import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Course, CourseContent } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { CardDescription } from '@lms/ui/components/card';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';

interface ImportCardProps {
  otherCourses: Course[];
  importSourceId: string;
  setImportSourceId: Dispatch<SetStateAction<string>>;
  importContent: CourseContent | null;
  importSections: string[];
  setImportSections: Dispatch<SetStateAction<string[]>>;
  importModules: string[];
  setImportModules: Dispatch<SetStateAction<string[]>>;
  onSubmitImport: (event: FormEvent) => void;
  selectClass: string;
}

/** Thẻ "Dùng lại từ khoá khác" của trang Xây dựng khoá. */
export function ImportCard({
  otherCourses, importSourceId, setImportSourceId, importContent, importSections,
  setImportSections, importModules, setImportModules, onSubmitImport, selectClass,
}: ImportCardProps) {
  const { t } = useTranslation('app');
  const submitImport = onSubmitImport;
  return (
      <Card>
        <CardHeader>
          <CardTitle>{t('builderImportTitle')}</CardTitle>
          <CardDescription>{t('builderImportDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void submitImport(e)} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="import-source">{t('builderImportSource')}</Label>
              <select id="import-source" className={selectClass} value={importSourceId} onChange={(e) => setImportSourceId(e.target.value)}>
                <option value="">{t('wizardPickSource')}</option>
                {otherCourses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName} ({c.shortName})
                  </option>
                ))}
              </select>
            </div>
            {importContent ? (
              <div className="space-y-3">
                {importContent.sections.map((s) => (
                  <div key={s.id} className="space-y-1 rounded border p-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      <input
                        type="checkbox"
                        checked={importSections.includes(s.id)}
                        onChange={(e) =>
                          setImportSections((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))
                        }
                      />
                      {s.name ?? t('sectionDefaultName', { number: s.section })} {t('builderImportWholeSection')}
                    </label>
                    {s.modules.map((m) => (
                      <label key={m.id} className="ml-6 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={importModules.includes(m.id)}
                          onChange={(e) =>
                            setImportModules((prev) => (e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id)))
                          }
                        />
                        {m.name || m.component}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
            <Button type="submit" disabled={!importSourceId || (importSections.length === 0 && importModules.length === 0)}>
              {t('builderImportSubmit')}
            </Button>
          </form>
        </CardContent>
      </Card>
  );
}
