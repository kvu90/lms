import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Course, CourseCategory, CourseCategoryTreeNode } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { apiJson } from '#lib/api';
import { FrameUnitPicker } from '../components/frame-picker';
import {
  fetchFrameUnitsFor, fetchSubjects, fetchSystemContextId,
  type CurriculumSubject, type FrameUnit,
} from '#lib/curriculum';

/**
 * Wizard tạo khoá học (K1 — issue #68): màn riêng theo chuẩn §9 với
 * NĂM đường tạo khoá cho giáo viên:
 *  1. Từ khung chương trình GDPT 2018 (K0a): tạo khoá trắng gắn môn ×
 *     khối rồi nạp ngay các đơn vị khung đã tích chọn.
 *  2. Từ khung SGK (K0b — feat #67 đang thi công song song): đường này
 *     dựng theo cùng interface khung của K0a; khi K0b merge, panel này
 *     nối vào tầng SGK — hiện hiển thị trạng thái chờ nối, không giả
 *     vờ có dữ liệu.
 *  3. Nhân bản khoá có sẵn (Re-run): chọn nguồn → tên/mã được điền sẵn
 *     → ngày bắt đầu mới (tuỳ chọn, làm mốc lùi hạn) → tạo; tối đa 4
 *     thao tác. Bản sao là nháp, không chứa người học/bài làm.
 *  4. Khoá trắng: chỉ thông tin cơ bản.
 *  5. Từ khoá mẫu tổ/trường: danh sách mẫu từ GET /courses/templates,
 *     tạo qua cùng endpoint nhân bản.
 * Tạo xong chuyển thẳng tới Builder Outline của khoá mới.
 */
type WizardPath = 'frame' | 'textbook' | 'duplicate' | 'blank' | 'template';

const PATHS: { key: WizardPath; titleKey: string; descKey: string }[] = [
  { key: 'frame', titleKey: 'wizardPathFrame', descKey: 'wizardPathFrameDesc' },
  { key: 'textbook', titleKey: 'wizardPathTextbook', descKey: 'wizardPathTextbookDesc' },
  { key: 'duplicate', titleKey: 'wizardPathDuplicate', descKey: 'wizardPathDuplicateDesc' },
  { key: 'blank', titleKey: 'wizardPathBlank', descKey: 'wizardPathBlankDesc' },
  { key: 'template', titleKey: 'wizardPathTemplate', descKey: 'wizardPathTemplateDesc' },
];

export function CourseNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const [path, setPath] = useState<WizardPath>('blank');
  const [categories, setCategories] = useState<CourseCategory[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [templates, setTemplates] = useState<Course[]>([]);
  const [fullName, setFullName] = useState('');
  const [shortName, setShortName] = useState('');
  const [category, setCategory] = useState('');
  const [startDate, setStartDate] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Đường khung chương trình.
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [grade, setGrade] = useState('');
  const [frameUnits, setFrameUnits] = useState<FrameUnit[]>([]);
  const [frameCurriculumId, setFrameCurriculumId] = useState<string | null>(null);
  const [frameSelected, setFrameSelected] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const [tree, list, tpl] = await Promise.all([
        apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree').catch(() => []),
        apiJson<Course[]>('/api/v1/courses').catch(() => []),
        apiJson<Course[]>('/api/v1/courses/templates').catch(() => []),
      ]);
      const flat: CourseCategory[] = [];
      const walk = (nodes: CourseCategoryTreeNode[]) => {
        for (const n of nodes) {
          flat.push(n);
          walk(n.children);
        }
      };
      walk(tree);
      setCategories(flat);
      if (flat.length > 0) setCategory(String(flat[0]!.id));
      setCourses(list);
      setTemplates(tpl);
      try {
        const contextId = await fetchSystemContextId();
        if (contextId) setSubjects(await fetchSubjects(contextId));
      } catch {
        setSubjects([]);
      }
    })();
  }, []);

  useEffect(() => {
    setFrameSelected([]);
    if (!subjectId || !grade) {
      setFrameUnits([]);
      setFrameCurriculumId(null);
      return;
    }
    void fetchFrameUnitsFor(subjectId, Number(grade))
      .then(({ curriculumId, units }) => {
        setFrameCurriculumId(curriculumId);
        setFrameUnits(units);
      })
      .catch(() => {
        setFrameCurriculumId(null);
        setFrameUnits([]);
      });
  }, [subjectId, grade]);

  /** Chọn khoá nguồn (nhân bản/mẫu): điền sẵn tên + mã cho bản sao để giáo viên sửa tối thiểu. */
  function pickSource(course: Course | undefined) {
    if (!course) return;
    setFullName(`${course.fullName} ${t('wizardCopySuffix')}`);
    setShortName(`${course.shortName}-copy`);
    setCategory(course.category);
  }

  async function goToBuilder(courseId: string) {
    await navigate(`/courses/${courseId}/builder`);
  }

  /** Đường nhân bản + mẫu: POST /courses/:id/duplicate (bản sao nháp; startDate mới = mốc lùi hạn). */
  async function submitDuplicate(event: FormEvent) {
    event.preventDefault();
    const fromId = path === 'template' ? templateId : sourceId;
    if (!fromId) return;
    setBusy(true);
    setMessage(null);
    try {
      const created = await apiJson<Course>(`/api/v1/courses/${fromId}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({
          fullName,
          shortName,
          ...(category ? { category } : {}),
          ...(startDate ? { startDate } : {}),
        }),
      });
      await goToBuilder(created.id);
    } catch {
      setMessage(t('wizardCreateFailed'));
      setBusy(false);
    }
  }

  /** Đường khoá trắng + khung chương trình: POST /courses rồi nạp khung khi đã tích chọn đơn vị. */
  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const created = await apiJson<Course>('/api/v1/courses', {
        method: 'POST',
        body: JSON.stringify({
          fullName,
          shortName,
          category,
          ...(startDate ? { startDate } : {}),
          ...(path === 'frame' && subjectId ? { subjectId } : {}),
          ...(path === 'frame' && grade ? { grade: Number(grade) } : {}),
        }),
      });
      if (path === 'frame' && frameCurriculumId && frameSelected.length > 0) {
        try {
          await apiJson(`/api/v1/courses/${created.id}/curriculum-frame`, {
            method: 'POST',
            body: JSON.stringify({ curriculumId: frameCurriculumId, nodeIds: frameSelected }),
          });
        } catch {
          // Khoá đã tạo nhưng nạp khung lỗi: vẫn vào builder, báo rõ để nạp lại từ panel khung.
          setMessage(t('courseCreatedFrameFailed'));
          setBusy(false);
          await goToBuilder(created.id);
          return;
        }
      }
      await goToBuilder(created.id);
    } catch {
      setMessage(t('wizardCreateFailed'));
      setBusy(false);
    }
  }

  const selectClass = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';
  const isDuplicatePath = path === 'duplicate' || path === 'template';

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('wizardTitle')}</CardTitle>
          <CardDescription>{t('wizardDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label={t('wizardTitle')}>
            {PATHS.map((p) => (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={path === p.key}
                data-testid={`wizard-path-${p.key}`}
                onClick={() => setPath(p.key)}
                className={`rounded border p-3 text-left ${path === p.key ? 'border-primary bg-accent' : ''}`}
              >
                <span className="block font-medium">{t(p.titleKey)}</span>
                <span className="block text-sm text-muted-foreground">{t(p.descKey)}</span>
              </button>
            ))}
          </div>

          {path === 'textbook' ? (
            <div className="space-y-3" data-testid="wizard-textbook-panel">
              <p className="text-sm">{t('wizardTextbookPending')}</p>
              <Button type="button" variant="outline" onClick={() => setPath('frame')}>
                {t('wizardUseFrameInstead')}
              </Button>
            </div>
          ) : (
            <form onSubmit={isDuplicatePath ? submitDuplicate : submitCreate} className="space-y-3">
              {path === 'duplicate' ? (
                <div className="space-y-2">
                  <Label htmlFor="wizard-source">{t('wizardSourceCourse')}</Label>
                  <select
                    id="wizard-source"
                    className={selectClass}
                    value={sourceId}
                    onChange={(e) => {
                      setSourceId(e.target.value);
                      pickSource(courses.find((c) => c.id === e.target.value));
                    }}
                  >
                    <option value="">{t('wizardPickSource')}</option>
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fullName} ({c.shortName})
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {path === 'template' ? (
                <div className="space-y-2">
                  <Label htmlFor="wizard-template">{t('wizardTemplateCourse')}</Label>
                  <select
                    id="wizard-template"
                    className={selectClass}
                    value={templateId}
                    onChange={(e) => {
                      setTemplateId(e.target.value);
                      pickSource(templates.find((c) => c.id === e.target.value));
                    }}
                  >
                    <option value="">{t('wizardPickTemplate')}</option>
                    {templates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.fullName} ({c.shortName})
                      </option>
                    ))}
                  </select>
                  {templates.length === 0 ? <p className="text-sm text-muted-foreground">{t('wizardNoTemplates')}</p> : null}
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor="wizard-fullname">{t('courseFullName')}</Label>
                <Input id="wizard-fullname" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-shortname">{t('courseShortName')}</Label>
                <Input id="wizard-shortname" value={shortName} onChange={(e) => setShortName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-category">{t('courseCategory')}</Label>
                <select id="wizard-category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="wizard-startdate">{t('courseStartDate')}</Label>
                <Input id="wizard-startdate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                {isDuplicatePath ? <p className="text-sm text-muted-foreground">{t('wizardStartDateHint')}</p> : null}
              </div>
              {path === 'frame' ? (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="wizard-subject">{t('courseSubject')}</Label>
                    <select id="wizard-subject" className={selectClass} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                      <option value="">{t('courseSubjectNone')}</option>
                      {subjects.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wizard-grade">{t('courseGrade')}</Label>
                    <select id="wizard-grade" className={selectClass} value={grade} onChange={(e) => setGrade(e.target.value)}>
                      <option value="">{t('courseGradeNone')}</option>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                        <option key={g} value={g}>
                          {t('curriculumGradeLabel', { grade: g })}
                        </option>
                      ))}
                    </select>
                  </div>
                  {frameCurriculumId ? (
                    <div className="space-y-2">
                      <Label>{t('courseFrameUnitsTitle')}</Label>
                      <FrameUnitPicker
                        units={frameUnits}
                        selected={frameSelected}
                        idPrefix="wizard-frame"
                        onToggle={(nodeId, checked) =>
                          setFrameSelected((prev) => (checked ? [...prev, nodeId] : prev.filter((id) => id !== nodeId)))
                        }
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy || (isDuplicatePath && !(path === 'template' ? templateId : sourceId))}>
                  {t('wizardCreateAndBuild')}
                </Button>
                <Link className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 text-sm font-medium" to="/courses">{t('wizardBackToCourses')}</Link>
              </div>
            </form>
          )}
          {message ? (
            <p role="status" className="text-sm">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default CourseNewPage;
