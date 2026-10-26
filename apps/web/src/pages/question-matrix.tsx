import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
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
import { apiJson } from '#lib/api';
import {
  downloadMatrixSpecification,
  useAddMatrixCell,
  useCurriculaBySubject,
  useCurriculumSubjects,
  useCurriculumTree,
  useDeleteMatrixCell,
  useMatrixAvailability,
  useMatrixBanks,
  useMatrixDetail,
  useMatrixSpecification,
  useUpdateMatrix,
  type SpecificationOutcomeLite,
} from '#lib/matrix-data';
import { usePermissions } from '#lib/permissions';
import {
  COGNITIVE_LEVELS, LEVEL_LABEL_KEYS, QTYPES, QTYPE_LABEL_KEYS, withApiReason,
  type CurriculumTreeNode,
} from './questions';

/**
 * Màn tạo/sửa MA TRẬN trong ngân hàng ma trận (MB-1, issue #111) —
 * chuẩn §9: tạo mới và sửa là MÀN RIÊNG, danh sách (collapse "Ma trận
 * của tôi" ở trang ngân hàng) chỉ có nút Thêm mới và Sửa/Xoá tại dòng.
 * Ma trận tạo từ đây luôn thuộc bank ma trận CÁ NHÂN của giáo viên
 * (bank_id gửi kèm; API gác quyền phụ trách tại chính bank đó).
 *
 * Flow tổng thể của file: route module prefetch dữ liệu nền qua các
 * queryOptions của `lib/matrix-data.ts` → trang đọc lại bằng cùng
 * khoá qua hooks (chi tiết ma trận là query chính; cây chương trình +
 * khả dụng kho câu là query phụ) → form sửa gửi qua các mutation của
 * cùng module dữ liệu, mutation thành công thì invalidate để trang
 * nạp lại trạng thái mới.
 *
 * Mục BẢN ĐẶC TẢ (SPEC-1, issue #233) ở cuối trang sửa: dữ liệu vào là
 * view model đặc tả do API SUY RA từ các ô của ma trận → trang chỉ
 * trình bày (bảng phẳng một dòng = một ô, cột YCCĐ lấy từ ĐVK của ô)
 * và xuất file qua endpoint export sẵn có; trang KHÔNG có thao tác
 * nhập/sửa đặc tả vì đặc tả không phải dữ liệu nhập riêng.
 */

const SELECT_CLASS = 'h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs';

/** Bung cây chương trình thành danh sách ĐƠN VỊ KIẾN THỨC (node) cho bộ chọn ô ma trận — ô neo ĐVK, không neo YCCĐ (issue #249). Nhãn kèm thụt cấp theo độ sâu để phân biệt chủ đề/bài. */
function flattenNodes(nodes: CurriculumTreeNode[], depth = 0): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const node of nodes) {
    out.push({ id: node.id, title: `${'— '.repeat(depth)}${node.title}` });
    out.push(...flattenNodes(node.children ?? [], depth + 1));
  }
  return out;
}

/**
 * Suy mã vị trí hiển thị của một YCCĐ trong bản đặc tả.
 *
 * Mã chuẩn theo sổ quyết định mục B là `<mã bản ghi>.<số thứ tự 2 chữ
 * số>` (vd `TOAN-0001.02`; bản derived là `<mã gốc>/<mức>`). API đặc
 * tả hiện chưa trả position/mã bản ghi riêng cho từng YCCĐ nên hàm
 * này suy từ dữ kiện có sẵn, theo các bước: (1) trích mã bản ghi từ
 * đuôi `sourceRef` (dạng "… — bản ghi <mã>"); (2) đếm thứ tự của YCCĐ
 * trong nhóm anh em CÙNG bản ghi và không phải derived — API trả danh
 * sách YCCĐ của node theo position tăng dần nên thứ tự đếm khớp
 * position của bản ghi trong trường hợp dữ liệu chương trình chuẩn.
 *
 * Bất biến/ràng buộc: YCCĐ derived trả null (mã của nó phải suy từ
 * YCCĐ gốc + mức, API chưa cho biết liên kết gốc ở bề mặt này); YCCĐ
 * không có `sourceRef` truy được mã bản ghi cũng trả null — thà
 * không hiện tiền tố còn hơn hiện mã đoán sai.
 *
 * @param outcome - YCCĐ cần suy mã.
 * @param siblings - Toàn bộ YCCĐ của cùng ĐVK, theo đúng thứ tự API trả.
 * @returns Mã vị trí dạng tiền tố, hoặc null khi không suy được.
 */
function outcomeCodePrefix(outcome: SpecificationOutcomeLite, siblings: SpecificationOutcomeLite[]): string | null {
  const recordId = outcome.sourceRef?.match(/bản ghi\s+(\S+)\s*$/)?.[1];
  if (!recordId || outcome.sourceKind === 'derived') return null;
  const ordinal =
    siblings
      .filter((s) => s.sourceKind !== 'derived' && s.sourceRef?.match(/bản ghi\s+(\S+)\s*$/)?.[1] === recordId)
      .findIndex((s) => s.outcomeId === outcome.outcomeId) + 1;
  return ordinal > 0 ? `${recordId}.${String(ordinal).padStart(2, '0')}` : null;
}

/** Màn tạo ma trận mới trong bank ma trận cá nhân (route /matrices/new). */
export function MatrixNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  // Dữ liệu nền qua TanStack (F-01 đợt 1): bank ma trận + môn học chỉ
  // tải khi quyền đã rõ (clientLoader của route new đã prefetch cùng
  // khoá); chương trình theo môn đang chọn qua query keyed theo môn.
  const canLoad = perms.ready && perms.canUseQuestionBank;
  const banksQuery = useMatrixBanks(canLoad);
  const personalBankId = banksQuery.data?.find((b) => b.scope === 'personal')?.id ?? null;
  const bankLoaded = banksQuery.isSuccess || banksQuery.isError;
  const subjects = useCurriculumSubjects(canLoad).data ?? [];
  const [name, setName] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [curriculumId, setCurriculumId] = useState('');
  const curriculaQuery = useCurriculaBySubject(subjectId);
  const curricula = curriculaQuery.data ?? [];
  const [includeAdvanced, setIncludeAdvanced] = useState(false);
  const [totalScore, setTotalScore] = useState('10');
  const [isTemplate, setIsTemplate] = useState(false);
  const [status, setStatus] = useState('draft');
  const [message, setMessage] = useState<string | null>(null);

  // Đổi môn: giữ lựa chọn chương trình nếu còn thuộc môn mới, không
  // thì tự chọn chương trình đầu (đúng nhịp effect thủ công trước đây).
  useEffect(() => {
    if (!subjectId) {
      setCurriculumId('');
      return;
    }
    const rows = curriculaQuery.data;
    if (!rows) return;
    setCurriculumId((prev) => (rows.some((c) => c.id === prev) ? prev : (rows[0]?.id ?? '')));
  }, [subjectId, curriculaQuery.data]);

  async function createMatrix(event: FormEvent) {
    event.preventDefault();
    if (!personalBankId) return;
    try {
      await apiJson('/api/v1/exam-matrices', {
        method: 'POST',
        body: JSON.stringify({
          name, subjectId, curriculumId, bankId: personalBankId, levelSet: includeAdvanced ? 'four' : 'three',
          totalScore: Number(totalScore) || 10, isTemplate, status,
        }),
      });
      navigate('/matrices', { state: { notice: t('matrixCreated') } });
    } catch (err) {
      setMessage(withApiReason(t('matrixCreateFailed'), err));
    }
  }

  if (!perms.ready || !bankLoaded) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixCreate')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }
  if (!perms.canUseQuestionBank || !personalBankId) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixCreate')} />
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

  return (
    <PageShell width="medium">
      <PageHeader title={t('matrixCreate')} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={(e) => void createMatrix(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="matrix-name">{t('matrixName')}</FieldLabel>
                <Input id="matrix-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-subject">{t('matrixSubject')}</FieldLabel>
                <select id="matrix-subject" className={SELECT_CLASS} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required>
                  <option value="">—</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-curriculum">{t('matrixCurriculum')}</FieldLabel>
                <select id="matrix-curriculum" className={SELECT_CLASS} value={curriculumId} onChange={(e) => setCurriculumId(e.target.value)} required>
                  <option value="">—</option>
                  {curricula.map((c) => (
                    <option key={c.id} value={c.id}>
                      {t('matrixGradeOption', { grade: c.grade })}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="text-sm text-muted-foreground">{t('matrixCv7991Note')}</p>
              <div className="flex items-center gap-2">
                <Checkbox id="matrix-advanced" checked={includeAdvanced} onCheckedChange={(v) => setIncludeAdvanced(v === true)} />
                <Label htmlFor="matrix-advanced">{t('matrixIncludeAdvanced')}</Label>
              </div>
              <Field>
                <FieldLabel htmlFor="matrix-total-score">{t('matrixTotalScore')}</FieldLabel>
                <Input
                  id="matrix-total-score"
                  type="number"
                  min="1"
                  step="0.5"
                  value={totalScore}
                  onChange={(e) => setTotalScore(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="matrix-status">{t('matrixStatus')}</FieldLabel>
                <select id="matrix-status" className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="draft">{t('matrixStatusDraft')}</option>
                  <option value="ready">{t('matrixStatusReady')}</option>
                </select>
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="matrix-template" checked={isTemplate} onCheckedChange={(v) => setIsTemplate(v === true)} />
                <Label htmlFor="matrix-template">{t('matrixIsTemplate')}</Label>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={!name.trim() || !subjectId || !curriculumId}>
                  {t('matrixCreate')}
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                  {t('backToQuestionBankList')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Màn sửa ma trận (route /matrices/:matrixId/edit): thông tin chung + các ô + khả dụng theo ô. */
export function MatrixEditPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  const { matrixId } = useParams<{ matrixId: string }>();
  // Dữ liệu trang qua TanStack (F-01 đợt 1): chi tiết ma trận là query
  // chính (clientLoader của route edit đã prefetch cùng khoá); cây
  // chương trình + khả dụng là query phụ; chờ tải đầu qua trạng thái
  // chưa có dữ liệu chi tiết như trước (F-14).
  const canLoad = perms.ready && perms.canUseQuestionBank;
  const detailQuery = useMatrixDetail(matrixId, canLoad);
  const matrix = detailQuery.data ?? null;
  const treeQuery = useCurriculumTree(matrix?.curriculumId, !!matrix);
  const nodes = treeQuery.data ? flattenNodes(treeQuery.data) : [];
  const availability = useMatrixAvailability(matrixId, canLoad && !!matrix).data ?? null;
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('draft');
  const [isTemplate, setIsTemplate] = useState(false);
  // Checkbox Vận dụng cao (I-3, issue #233): màn tạo đã có checkbox
  // này từ trước; màn sửa bổ sung cùng một điều khiển thay cho mọi
  // lựa chọn levelSet dạng select (không còn select nào trên web) —
  // tick = levelSet 'four', không tick = 'three'.
  const [includeAdvanced, setIncludeAdvanced] = useState(false);
  const [totalScore, setTotalScore] = useState('10');
  const [cellNodeId, setCellNodeId] = useState('');
  const [cellLevel, setCellLevel] = useState('biet');
  const [cellQtype, setCellQtype] = useState('multichoice');
  const [cellCount, setCellCount] = useState('1');
  const [cellScore, setCellScore] = useState('1');

  const updateMutation = useUpdateMatrix();
  const addCellMutation = useAddMatrixCell();
  const deleteCellMutation = useDeleteMatrixCell();

  // Bản đặc tả (SPEC-1, issue #233): mục riêng trong trang sửa ma trận,
  // chỉ tải khi giáo viên mở xem — đặc tả là bảng SUY RA từ các ô nên
  // luôn khớp trạng thái ma trận hiện tại, không có thao tác sửa ở đây.
  const [specOpen, setSpecOpen] = useState(false);
  const specQuery = useMatrixSpecification(matrixId, canLoad && !!matrix && specOpen);
  const spec = specQuery.data ?? null;

  /**
   * Xuất bản đặc tả của ma trận đang sửa ra file và tải về máy.
   *
   * Flow: uỷ thác toàn bộ lượt tải cho `downloadMatrixSpecification`
   * (tầng dữ liệu lo endpoint + tên file của server); lỗi HTTP thì
   * bắt tại đây và báo lên banner của trang kèm lý do API, theo đúng
   * khuôn báo lỗi của các thao tác khác trong trang.
   *
   * @param format - 'xlsx' cho bản Excel, 'docx' cho bản Word.
   */
  async function exportSpec(format: 'xlsx' | 'docx') {
    if (!matrix) return;
    try {
      await downloadMatrixSpecification(matrix.id, format);
    } catch (err) {
      setMessage(withApiReason(t('specExportFailed'), err));
    }
  }

  // Nạp hỏng chi tiết: báo lỗi tải như nhịp loadMatrix thủ công cũ.
  useEffect(() => {
    if (detailQuery.isError) setMessage(t('matrixLoadFailed'));
  }, [detailQuery.isError, t]);

  // Khởi tạo các trường form từ bản ghi mỗi khi chi tiết (lại) tải về —
  // đúng nhịp loadMatrix cũ, vốn chạy lại sau mỗi đột biến thành công.
  useEffect(() => {
    if (!detailQuery.data) return;
    const row = detailQuery.data;
    setName(row.name);
    setStatus(row.status);
    setIsTemplate(row.isTemplate);
    setIncludeAdvanced(row.levelSet === 'four');
    setTotalScore(String(row.totalScore));
  }, [detailQuery.data]);

  async function saveMatrix(event: FormEvent) {
    event.preventDefault();
    if (!matrix) return;
    try {
      await updateMutation.mutateAsync({
        matrixId: matrix.id,
        body: {
          name, status, isTemplate, totalScore: Number(totalScore) || 10,
          levelSet: includeAdvanced ? 'four' : 'three',
        },
      });
      setMessage(t('matrixSaved'));
    } catch (err) {
      setMessage(withApiReason(t('matrixSaveFailed'), err));
    }
  }

  async function addCell(event: FormEvent) {
    event.preventDefault();
    if (!matrix || !cellNodeId) return;
    try {
      await addCellMutation.mutateAsync({
        matrixId: matrix.id,
        body: {
          curriculumNodeId: cellNodeId, cognitiveLevel: cellLevel, qtype: cellQtype,
          questionCount: Number(cellCount) || 1, cellScore: Number(cellScore) || 1,
        },
      });
    } catch (err) {
      setMessage(withApiReason(t('matrixCellAddFailed'), err));
    }
  }

  async function deleteCell(cellId: string) {
    if (!matrix) return;
    try {
      await deleteCellMutation.mutateAsync({ matrixId: matrix.id, cellId });
    } catch (err) {
      setMessage(withApiReason(t('matrixCellDeleteFailed'), err));
    }
  }

  if (!perms.ready || !matrix) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('matrixEditTitle')} />
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </PageShell>
    );
  }

  // Các dòng phẳng của bản đặc tả: một dòng = một ô ma trận, STT chạy
  // toàn bảng như bản xuất xlsx/docx.
  const specRows = spec
    ? spec.topics.flatMap((topic) =>
        topic.nodes.flatMap((node) => node.cells.map((cell) => ({ topic, node, cell }))),
      )
    : [];

  const nodeLabel = (id: string) => nodes.find((n) => n.id === id)?.title ?? id.slice(0, 8);
  const availabilityOf = (cellId: string) => availability?.cells.find((c) => c.cellId === cellId);

  return (
    <PageShell width="medium">
      <PageHeader title={t('matrixEditTitle')} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            {matrix.name} <span className="text-sm font-normal text-muted-foreground">v{matrix.version}</span>
          </CardTitle>
          <CardDescription>{t('myMatrixBank')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={(e) => void saveMatrix(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="edit-matrix-name">{t('matrixName')}</FieldLabel>
                <Input id="edit-matrix-name" value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-matrix-status">{t('matrixStatus')}</FieldLabel>
                <select id="edit-matrix-status" className={SELECT_CLASS} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="draft">{t('matrixStatusDraft')}</option>
                  <option value="ready">{t('matrixStatusReady')}</option>
                  <option value="hidden">{t('matrixStatusHidden')}</option>
                </select>
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-matrix-score">{t('matrixTotalScore')}</FieldLabel>
                <Input
                  id="edit-matrix-score"
                  type="number"
                  min="1"
                  step="0.5"
                  value={totalScore}
                  onChange={(e) => setTotalScore(e.target.value)}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Checkbox id="edit-matrix-template" checked={isTemplate} onCheckedChange={(v) => setIsTemplate(v === true)} />
                <Label htmlFor="edit-matrix-template">{t('matrixIsTemplate')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="edit-matrix-advanced" checked={includeAdvanced} onCheckedChange={(v) => setIncludeAdvanced(v === true)} />
                <Label htmlFor="edit-matrix-advanced">{t('matrixIncludeAdvanced')}</Label>
              </div>
              <div className="flex gap-2">
                <Button type="submit">{t('matrixEditTitle')}</Button>
                <Button type="button" variant="outline" onClick={() => navigate('/matrices')}>
                  {t('backToQuestionBankList')}
                </Button>
              </div>
            </FieldGroup>
          </form>

          <div className="space-y-3">
            <h3 className="font-medium">{t('matrixCells')}</h3>
            {matrix.cells.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {matrix.cells.map((cell) => {
                  const av = availabilityOf(cell.id);
                  return (
                    <li key={cell.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm">
                        {nodeLabel(cell.curriculumNodeId)} ·{' '}
                        {t(LEVEL_LABEL_KEYS[cell.cognitiveLevel as (typeof COGNITIVE_LEVELS)[number]] ?? 'levelBiet')} ·{' '}
                        {t(QTYPE_LABEL_KEYS[cell.qtype as (typeof QTYPES)[number]] ?? 'qtypeMultichoice')} ·{' '}
                        {cell.questionCount} × {cell.cellScore}
                        {av ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('matrixAvailabilityRequired')}: {av.required} · {t('matrixAvailabilityAvailable')}: {av.available} ·{' '}
                            {t('matrixAvailabilityDeficit')}: {av.deficit}
                          </span>
                        ) : null}
                      </span>
                      <Button type="button" variant="outline" onClick={() => void deleteCell(cell.id)}>
                        {t('deleteRow')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {availability ? (
              <p className="text-sm">
                {t('matrixAvailability')}:{' '}
                <span className="font-medium">
                  {availability.sufficient ? t('matrixAvailabilitySufficient') : t('matrixAvailabilityInsufficient')}
                </span>
              </p>
            ) : null}
            <form onSubmit={(e) => void addCell(e)} className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor="cell-node">{t('matrixCellNode')}</Label>
                <select
                  id="cell-node"
                  className={SELECT_CLASS}
                  value={cellNodeId}
                  onChange={(e) => setCellNodeId(e.target.value)}
                  required
                >
                  <option value="">—</option>
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-level">{t('matrixCellLevel')}</Label>
                <select id="cell-level" className={SELECT_CLASS} value={cellLevel} onChange={(e) => setCellLevel(e.target.value)}>
                  {COGNITIVE_LEVELS.filter((level) => matrix.levelSet === 'four' || level !== 'van_dung_cao').map((level) => (
                    <option key={level} value={level}>
                      {t(LEVEL_LABEL_KEYS[level])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-qtype">{t('matrixCellQtype')}</Label>
                <select id="cell-qtype" className={SELECT_CLASS} value={cellQtype} onChange={(e) => setCellQtype(e.target.value)}>
                  {QTYPES.map((qtype) => (
                    <option key={qtype} value={qtype}>
                      {t(QTYPE_LABEL_KEYS[qtype])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="cell-count">{t('matrixCellCount')}</Label>
                <Input id="cell-count" type="number" min="1" value={cellCount} onChange={(e) => setCellCount(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="cell-score">{t('matrixCellScore')}</Label>
                <Input id="cell-score" type="number" min="0.25" step="0.25" value={cellScore} onChange={(e) => setCellScore(e.target.value)} />
              </div>
              <Button type="submit" disabled={!cellNodeId}>
                {t('matrixAddCell')}
              </Button>
            </form>
          </div>

          {/*
            Mục BẢN ĐẶC TẢ (SPEC-1): ba trạng thái hiển thị theo nhịp
            tải lười — chưa mở thì chỉ có nút Xem + hai nút xuất (xuất
            không cần mở xem vì endpoint export tự dựng lại đặc tả ở
            server); đang tải thì khung xương; lỗi thì banner tại chỗ;
            có dữ liệu thì bảng phẳng + dòng tổng. Ma trận chưa có ô
            nào thì API trả topics rỗng → hiện câu trạng thái rỗng
            thay cho bảng.
          */}
          <div className="space-y-3">
            <h3 className="font-medium">{t('specSectionTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('specSectionHint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setSpecOpen((open) => !open)}>
                {specOpen ? t('specHide') : t('specView')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void exportSpec('xlsx')}>
                {t('specExportExcel')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void exportSpec('docx')}>
                {t('specExportWord')}
              </Button>
            </div>
            {specOpen ? (
              specQuery.isPending ? (
                <div className="space-y-2" aria-label={t('loading')}>
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : specQuery.isError ? (
                <Alert>
                  <AlertDescription>{t('specLoadFailed')}</AlertDescription>
                </Alert>
              ) : spec ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">{spec.purpose}</p>
                  {spec.topics.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('specEmpty')}</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left">
                            <th className="p-2">{t('specIndex')}</th>
                            <th className="p-2">{t('specTopic')}</th>
                            <th className="p-2">{t('matrixCellNode')}</th>
                            <th className="p-2">{t('specOutcome')}</th>
                            <th className="p-2">{t('matrixCellLevel')}</th>
                            <th className="p-2">{t('matrixCellQtype')}</th>
                            <th className="p-2">{t('matrixCellCount')}</th>
                            <th className="p-2">{t('specScore')}</th>
                            <th className="p-2">{t('specSlot')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {specRows.map(({ topic, node, cell }, rowIndex) => (
                                <tr key={cell.cellId} className="border-b align-top">
                                  <td className="p-2">{rowIndex + 1}</td>
                                  <td className="p-2">{topic.topicTitle}</td>
                                  <td className="p-2">{node.nodeTitle}</td>
                                  {/* Cột YCCĐ đọc từ NODE chứ không từ ô: mọi ô của cùng một ĐVK dùng chung danh sách YCCĐ của ĐVK đó (mô hình #249). */}
                                  <td className="p-2">
                                    {node.outcomes.length === 0 ? (
                                      <span className="text-muted-foreground">—</span>
                                    ) : (
                                      <ul className="flex flex-col gap-1">
                                        {node.outcomes.map((outcome) => {
                                          const code = outcomeCodePrefix(outcome, node.outcomes);
                                          return (
                                            <li key={outcome.outcomeId}>
                                              {code ? (
                                                <span className="mr-1 text-xs font-medium text-muted-foreground">{code}</span>
                                              ) : null}
                                              <span>{outcome.programContent ?? outcome.content}</span>
                                              {outcome.derivedContent ? (
                                                <span className="block text-xs text-muted-foreground">
                                                  {t('specDerivedNote', { content: outcome.derivedContent })}
                                                </span>
                                              ) : null}
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {t(LEVEL_LABEL_KEYS[cell.cognitiveLevel as (typeof COGNITIVE_LEVELS)[number]] ?? 'levelBiet')}
                                  </td>
                                  <td className="p-2">
                                    {t(QTYPE_LABEL_KEYS[cell.qtype as (typeof QTYPES)[number]] ?? 'qtypeMultichoice')}
                                  </td>
                                  {/* Số câu theo đúng cách đếm của bản xuất: câu Đúng–Sai chùm tính 4 ý. */}
                                  <td className="p-2">{cell.qtype === 'truefalse' ? cell.questionCount * 4 : cell.questionCount}</td>
                                  <td className="p-2">{cell.cellScore}</td>
                                  {/* Số thứ tự câu chỉ có khi đặc tả dựng theo một lần ghim cụ thể; đặc tả theo ma trận thuần luôn vắng → hiện ghi chú rút (nếu có) hoặc dấu —. */}
                                  <td className="p-2">
                                    {cell.slotNumbers && cell.slotNumbers.length
                                      ? cell.drawNote
                                        ? `${cell.drawNote} (${t('dossierSpecSlots', { slots: cell.slotNumbers.join(', ') })})`
                                        : cell.slotNumbers.join(', ')
                                      : (cell.drawNote ?? '—')}
                                  </td>
                                </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="text-sm font-medium">
                    {t('dossierSpecTotals', { count: spec.totals.totalQuestions, score: spec.totals.totalScore })}
                  </p>
                </div>
              ) : null
            ) : null}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
