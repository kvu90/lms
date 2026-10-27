import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { Skeleton } from '@lms/ui/components/skeleton';
import { useTranslation } from 'react-i18next';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { ApiError } from '#lib/api';
import {
  commitMatrixImport,
  downloadMatrixImportTemplate,
  previewMatrixImport,
  useCurriculaBySubject,
  useCurriculumSubjects,
} from '#lib/matrix-data';
import { useCourseList } from '#lib/course-new-data';
import { usePermissions } from '#lib/permissions';
import type { ExamMatrixView, MatrixImportIssue, MatrixImportPreview } from '@lms/contracts';
import {
  COGNITIVE_LEVELS, LEVEL_LABEL_KEYS, QTYPES, QTYPE_LABEL_KEYS, withApiReason,
} from './questions';

/**
 * Wizard NHẬP MA TRẬN TỪ FILE (lát I-3, issue #233) — bề mặt web của
 * chuỗi I-1 (xem trước) → I-2 (ghi nguyên tử). Trang KHÔNG tự tính
 * lại luật nào: mọi luật hợp lệ, tính tổng và khả dụng đều do server
 * trả trong kết quả xem trước; web chỉ trình bày và chuyển file.
 *
 * Flow tổng thể 5 bước, file là nguồn sự thật duy nhất xuyên suốt:
 * (1) chọn môn + chương trình + checkbox Vận dụng cao → tải workbook
 * mẫu do server sinh cho đúng bộ mức đó; (2) tải file .xlsx đã điền
 * lên; (3) xem trước: lưới ô dự thảo + cảnh báo + khả dụng, kèm bảng
 * lỗi định vị (sheet/dòng/cột/mã) khi `valid=false` — nút xác nhận
 * bị khoá khi còn lỗi; (4) xác nhận: gửi lại CHÍNH file đó lên bước
 * ghi (server parse lại từ đầu, không tin kết quả xem trước phía
 * client) — 422 kèm `matrixImportIssues` thì hiện lại bảng lỗi và
 * KHÔNG có ma trận nào được tạo, gửi lại cùng nội dung thì server
 * trả ma trận đã có thay vì tạo trùng; (5) kết quả: mở trang sửa
 * của ma trận vừa ghi (hoặc bản đã có khi trùng).
 *
 * Bất biến giữ ở mọi bước: ô neo ĐƠN VỊ KIẾN THỨC × mức × dạng (ma
 * trận KHÔNG gắn YCCĐ — YCCĐ trong xem trước chỉ để đối chiếu, ô
 * không dùng YCCĐ làm khoá); số câu Đúng–Sai là số CHÙM (1 chùm = 4 ý
 * theo chú thích 2 CV 7991); bộ mức mặc định 3 mức CV 7991, cột Vận
 * dụng cao chỉ tồn tại khi giáo viên tick checkbox ở bước 1 (và file
 * khai khớp) — không có select chọn levelSet nào trên luồng này.
 */

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs';

/** Các bước của wizard, theo đúng thứ tự nhiệm vụ I-3 giao. */
const STEP_KEYS = [
  'matrixImportStep1',
  'matrixImportStep2',
  'matrixImportStep3',
  'matrixImportStep4',
  'matrixImportStep5',
] as const;

/**
 * Một lỗi cứng định vị trong file nhập (cùng hình dạng
 * `MatrixImportIssue` của contracts, ở cả xem trước lẫn 422 lúc ghi).
 *
 * @param issue - Lỗi cần trình bày; `row`/`column` null khi lỗi thuộc
 *   toàn file hoặc khối thông tin chung không định vị được một ô.
 */
function IssueTable({ issues }: { issues: MatrixImportIssue[] }) {
  const { t } = useTranslation('app');
  if (issues.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{t('matrixImportErrors')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">{t('matrixImportSheet')}</th>
              <th className="p-2">{t('matrixImportRow')}</th>
              <th className="p-2">{t('matrixImportColumn')}</th>
              <th className="p-2">{t('matrixImportCode')}</th>
              <th className="p-2">{t('matrixImportMessage')}</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue, index) => (
              <tr key={`${issue.code}-${issue.row ?? ''}-${issue.column ?? ''}-${index}`} className="border-b align-top">
                <td className="p-2">{issue.sheet ?? '—'}</td>
                <td className="p-2">{issue.row ?? '—'}</td>
                <td className="p-2">{issue.column ?? '—'}</td>
                <td className="p-2">{issue.code}</td>
                <td className="p-2">{issue.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Trang wizard nhập ma trận từ file (route /matrices/import). */
export function MatrixImportPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();

  // Bước hiện tại của wizard (1–5); file + kết quả xem trước được giữ
  // xuyên suốt để bước ghi gửi lại đúng file đã xem trước.
  const [step, setStep] = useState(1);
  const [subjectId, setSubjectId] = useState('');
  const [curriculumId, setCurriculumId] = useState('');
  const [includeAdvanced, setIncludeAdvanced] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MatrixImportPreview | null>(null);
  const [commitIssues, setCommitIssues] = useState<MatrixImportIssue[] | null>(null);
  const [committed, setCommitted] = useState<ExamMatrixView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);

  // Khoá của giáo viên để mở nhánh đọc khung theo khoá (điểm nghẽn
  // D-3 của issue #233): môn/chương trình là dữ liệu quốc gia chung
  // nên khoá nào của giáo viên cũng cho cùng danh sách — `forCourseId`
  // chỉ mở cổng đọc, không lọc danh sách theo khoá. Danh sách khoá
  // phải về trước mới gọi, để tránh một lượt gọi không kèm khoá rồi
  // hiện lỗi giả trước khi khoá kịp về.
  const coursesQuery = useCourseList();
  const forCourseId = coursesQuery.data?.[0]?.id;
  const subjectsQuery = useCurriculumSubjects(
    perms.ready && perms.canUseQuestionBank && coursesQuery.data !== undefined,
    forCourseId,
  );
  const subjects = subjectsQuery.data ?? [];
  const curriculaQuery = useCurriculaBySubject(subjectId, forCourseId);
  const curricula = curriculaQuery.data ?? [];
  // Lỗi tải danh sách nền không còn nuốt thành rỗng im lặng: hiện trạng
  // thái lỗi ngay ở bước 1 để giáo viên biết đường liệt kê đang gãy
  // thay vì thấy hai dropdown chỉ có "—" mà không rõ lý do.
  const subjectsLoadFailed = subjectsQuery.isError || curriculaQuery.isError;

  // Đổi môn: giữ chương trình nếu còn thuộc môn mới, không thì tự
  // chọn chương trình đầu (cùng nhịp effect của màn tạo ma trận tay).
  useEffect(() => {
    if (!subjectId) {
      setCurriculumId('');
      return;
    }
    const rows = curriculaQuery.data;
    if (!rows) return;
    setCurriculumId((prev) => (rows.some((c) => c.id === prev) ? prev : (rows[0]?.id ?? '')));
  }, [subjectId, curriculaQuery.data]);

  /**
   * Bước 1 — tải workbook mẫu do server sinh cho đúng (môn, chương
   * trình, bộ mức) đã chọn. Tải xong vẫn ở bước 1 để giáo viên điền
   * số rồi bấm Tiếp tục sang bước tải file lên.
   */
  async function downloadTemplate() {
    if (!subjectId || !curriculumId) return;
    setTemplateBusy(true);
    try {
      await downloadMatrixImportTemplate({ subjectId, curriculumId, includeAdvanced });
      setMessage(null);
    } catch {
      setMessage(t('matrixImportTemplateFailed'));
    } finally {
      setTemplateBusy(false);
    }
  }

  /**
   * Bước 2 → 3 — gửi file lên bước xem trước. Server luôn trả 200 kể
   * cả khi file sai khuôn: `valid=false` kèm lỗi định vị thì trang
   * vẫn sang bước 3 để hiện bảng lỗi và khoá nút xác nhận; chỉ lỗi
   * mạng/HTTP mới báo banner và ở lại bước 2.
   */
  async function runPreview() {
    if (!file) {
      setMessage(t('matrixImportNoFile'));
      return;
    }
    setPreviewBusy(true);
    try {
      const result = await previewMatrixImport(file);
      setPreview(result);
      setCommitIssues(null);
      setMessage(null);
      setStep(3);
    } catch (err) {
      setMessage(withApiReason(t('matrixImportPreviewFailed'), err));
    } finally {
      setPreviewBusy(false);
    }
  }

  /**
   * Bước 4 → 5 — gửi lại CHÍNH file đã xem trước lên bước ghi.
   * Thành công (201) thì sang bước kết quả với view ma trận server
   * trả (bản mới tạo, hoặc bản đã có khi trùng nội dung — cả hai đều
   * mở được từ cùng một id). Thất bại 422 kèm `matrixImportIssues`
   * thì hiện lại bảng lỗi, ở lại bước 4, và KHÔNG có ma trận nào
   * được tạo ở lượt này — giáo viên sửa file rồi tải lại từ bước 2.
   */
  async function runCommit() {
    if (!file || !preview?.valid) return;
    setCommitBusy(true);
    try {
      const result = await commitMatrixImport(file);
      setCommitted(result);
      setCommitIssues(null);
      setMessage(null);
      setStep(5);
    } catch (err) {
      if (err instanceof ApiError && err.problem.matrixImportIssues?.length) {
        setCommitIssues(err.problem.matrixImportIssues);
        setMessage(t('matrixImportCommitRejected'));
      } else {
        setMessage(withApiReason(t('matrixImportCommitFailed'), err));
      }
    } finally {
      setCommitBusy(false);
    }
  }

  /** Chọn file mới thì kết quả xem trước cũ hết hiệu lực — xoá để wizard không ghi bằng file cũ. */
  function onFileChange(next: File | null) {
    setFile(next);
    setPreview(null);
    setCommitIssues(null);
  }

  if (!perms.ready) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixImport')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (!perms.canUseQuestionBank) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixImport')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('myMatrixBank')}</CardTitle>
            <CardDescription>{t('matrixNoPersonalBank')}</CardDescription>
          </CardHeader>
        </Card>
        <p>
          <Link to="/matrices" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  // Khả dụng của một ô dự thảo: khớp theo (ĐVK, mức, dạng) vì ô dự
  // thảo chưa có cellId (chỉ có sau khi ghi).
  const availabilityOf = (nodeId: string, level: string, qtype: string) =>
    preview?.availability.find(
      (a) => a.curriculumNodeId === nodeId && a.cognitiveLevel === level && a.qtype === qtype,
    );

  return (
    <PageShell width="medium">
      <PageHeader title={t('matrixImport')} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {/* Chỉ báo bước: bước hiện tại đánh dấu aria-current, các bước đã qua giữ nguyên thứ tự để giáo viên biết mình đang ở đâu. */}
      <ol className="flex flex-wrap gap-2 text-sm">
        {STEP_KEYS.map((key, index) => (
          <li
            key={key}
            aria-current={step === index + 1 ? 'step' : undefined}
            className={step === index + 1 ? 'font-medium' : 'text-muted-foreground'}
          >
            {t(key)}
          </li>
        ))}
      </ol>

      {step === 1 ? (
        <Card>
          <CardContent className="pt-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="import-subject">{t('matrixSubject')}</FieldLabel>
                <select
                  id="import-subject"
                  className={SELECT_CLASS}
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="import-curriculum">{t('matrixCurriculum')}</FieldLabel>
                <select
                  id="import-curriculum"
                  className={SELECT_CLASS}
                  value={curriculumId}
                  onChange={(e) => setCurriculumId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {curricula.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('matrixGradeOption', { grade: c.grade })}
                    </option>
                  ))}
                </select>
              </Field>
              {subjectsLoadFailed ? (
                <Alert variant="destructive">
                  <AlertDescription>{t('matrixImportSubjectsFailed')}</AlertDescription>
                </Alert>
              ) : null}
              <p className="text-sm text-muted-foreground">{t('matrixCv7991Note')}</p>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="import-advanced"
                  checked={includeAdvanced}
                  onCheckedChange={(v) => setIncludeAdvanced(v === true)}
                />
                <Label htmlFor="import-advanced">{t('matrixIncludeAdvanced')}</Label>
              </div>
              <p className="text-sm text-muted-foreground">{t('matrixImportTemplateHint')}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => void downloadTemplate()} disabled={!subjectId || !curriculumId || templateBusy}>
                  {t('matrixImportTemplateDownload')}
                </Button>
                <Button type="button" onClick={() => setStep(2)} disabled={!subjectId || !curriculumId}>
                  {t('matrixImportNext')}
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                  {t('backToQuestionBankList')}
                </Button>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <CardContent className="pt-6">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="import-file">{t('matrixImportFileLabel')}</FieldLabel>
                <Input
                  id="import-file"
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                />
              </Field>
              {file ? <p className="text-sm text-muted-foreground">{file.name}</p> : null}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setStep(1)}>
                  {t('matrixImportBack')}
                </Button>
                <Button type="button" onClick={() => void runPreview()} disabled={!file || previewBusy}>
                  {t('matrixImportPreview')}
                </Button>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>
      ) : null}

      {step === 3 && preview ? (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-1">
              <p className="font-medium">{preview.name ?? '—'}</p>
              <p className="text-sm text-muted-foreground">
                {t('matrixTotalScore')}: {preview.totalScore ?? '—'} ·{' '}
                {preview.levelSet === 'four' ? t('matrixImportLevelFour') : t('matrixImportLevelThree')}
              </p>
              <p className="text-sm font-medium">
                {t('matrixImportTotals', { count: preview.totals.totalQuestions, score: preview.totals.totalScore })}
              </p>
              {preview.totals.byForm.map((row) => (
                <p key={row.qtype} className="text-sm text-muted-foreground">
                  {t(QTYPE_LABEL_KEYS[row.qtype as (typeof QTYPES)[number]])}: {row.questionCount} · {row.score} ({row.percent}%)
                </p>
              ))}
            </div>
            {preview.warnings.length > 0 ? (
              <div className="space-y-1">
                <h3 className="font-medium">{t('matrixImportWarnings')}</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {preview.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <IssueTable issues={preview.errors} />
            {preview.valid ? (
              <div className="space-y-3">
                <h3 className="font-medium">{t('matrixImportCells')}</h3>
                <p className="text-sm text-muted-foreground">{t('matrixImportTruefalseNote')}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left">
                        <th className="p-2">{t('matrixCellNode')}</th>
                        <th className="p-2">{t('matrixCellLevel')}</th>
                        <th className="p-2">{t('matrixCellQtype')}</th>
                        <th className="p-2">{t('matrixCellCount')}</th>
                        <th className="p-2">{t('matrixCellScore')}</th>
                        <th className="p-2">{t('matrixImportAvailability')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) =>
                        preview.cells
                          .filter((cell) => cell.curriculumNodeId === row.nodeId)
                          .map((cell) => {
                            const av = availabilityOf(cell.curriculumNodeId, cell.cognitiveLevel, cell.qtype);
                            return (
                              <tr key={`${cell.curriculumNodeId}-${cell.cognitiveLevel}-${cell.qtype}`} className="border-b align-top">
                                <td className="p-2">
                                  {row.topicTitle} · {row.nodeTitle}
                                </td>
                                <td className="p-2">
                                  {t(LEVEL_LABEL_KEYS[cell.cognitiveLevel as (typeof COGNITIVE_LEVELS)[number]])}
                                </td>
                                <td className="p-2">{t(QTYPE_LABEL_KEYS[cell.qtype as (typeof QTYPES)[number]])}</td>
                                <td className="p-2">{cell.questionCount}</td>
                                <td className="p-2">{cell.cellScore}</td>
                                <td className="p-2">
                                  {av
                                    ? `${t('matrixAvailabilityRequired')}: ${av.required} · ${t('matrixAvailabilityAvailable')}: ${av.available} · ${t('matrixAvailabilityDeficit')}: ${av.deficit}`
                                    : '—'}
                                </td>
                              </tr>
                            );
                          }),
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                {t('matrixImportChooseOtherFile')}
              </Button>
              <Button type="button" onClick={() => setStep(4)} disabled={!preview.valid}>
                {t('matrixImportConfirm')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 4 && preview ? (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <div className="space-y-1">
              <p className="font-medium">{preview.name ?? '—'}</p>
              <p className="text-sm font-medium">
                {t('matrixImportTotals', { count: preview.totals.totalQuestions, score: preview.totals.totalScore })}
              </p>
              <p className="text-sm text-muted-foreground">
                {t('matrixImportWarnings')}: {preview.warnings.length}
              </p>
            </div>
            {commitIssues ? <IssueTable issues={commitIssues} /> : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                {t('matrixImportChooseOtherFile')}
              </Button>
              <Button type="button" onClick={() => void runCommit()} disabled={commitBusy}>
                {t('matrixImportCommit')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 5 && committed ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="font-medium">{t('matrixImportResult')}</p>
            <p className="text-sm text-muted-foreground">
              {committed.name} · {t('matrixTotalScore')}: {committed.totalScore} · {t('matrixCellsCount', { count: committed.cells.length })}
            </p>
            <div className="flex gap-2">
              <Button type="button" onClick={() => navigate(`/matrices/${committed.id}/edit`)}>
                {t('matrixImportOpenEdit')}
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                {t('matrixImportBackToList')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </PageShell>
  );
}
