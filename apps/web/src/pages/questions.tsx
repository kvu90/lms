import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  extractRichTextPlainText,
  type QuestionCategory,
  type QuestionUsage,
  type QuestionView,
  type RichTextDocument,
  type StimulusView,
} from '@lms/contracts';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Empty, EmptyHeader, EmptyTitle } from '@lms/ui/components/empty';
import { Field, FieldGroup, FieldLabel } from '@lms/ui/components/field';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@lms/ui/components/select';
import { Skeleton } from '@lms/ui/components/skeleton';
import { Textarea } from '@lms/ui/components/textarea';
import { useTranslation } from 'react-i18next';
import { BankAreaTabs } from '../components/bank-area-tabs';
import { CollapsibleSection } from '../components/collapsible-section';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiJson, ApiError } from '#lib/api';
import { usePermissions } from '#lib/permissions';
import { queryKeys } from '#lib/query-keys';
import {
  questionAttributionQueryOptions,
  questionDetailQueryOptions,
  questionDiscoveryQueryOptions,
  questionVersionsQueryOptions,
  useBankDossiers,
  useBankExamContributions,
  useBankExams,
  useBankMatrices,
  useBankMatrixContributions,
  useBankQuestionContributions,
  useCategoryQuestions,
  useCategoryStimuli,
  useMyBankQuestions,
  useMyDossiers,
  useQuestionBanks,
  clearQuestionBankListCache,
  useQuestionCategories,
  type AttributionLite,
  type BankLite,
  type ContributionLite,
  type DiscoveryItemLite,
  type DossierSpecLite,
  type ExamContributionLite,
  type MatrixContributionLite,
  type MatrixLite,
  type PaperSummaryLite,
} from '#lib/questions-data';
import { useCurriculumSubjects } from '#lib/matrix-data';
import { courseContentQueryOptions, coursesListQueryOptions } from '#lib/course-builder-data';
import { courseGroupsQueryOptions } from '#lib/progress-report-data';
import { DataTable, type DataColumn } from '#components/data-table';

/**
 * Thông báo lỗi kèm lý do thật từ API (ProblemDetails.detail) — trước
 * đây các catch nuốt lỗi gốc và chỉ hiện câu chung chung, giáo viên
 * không biết sai ở đâu (issue #55 mục 3). Export để màn editor riêng
 * (question-editor.tsx) dùng chung đúng hành vi này.
 */
export function withApiReason(fallback: string, err: unknown): string {
  if (err instanceof ApiError) {
    const reason = err.problem.detail ?? err.problem.title;
    if (reason) return `${fallback} ${reason}`;
  }
  return fallback;
}

/** Một lựa chọn ngữ cảnh cho form danh mục mới. */
interface ContextOption {
  id: string;
  level: number;
  label: string;
}

export const QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
export type Qtype = (typeof QTYPES)[number];

export const QTYPE_LABEL_KEYS: Record<Qtype, string> = {
  multichoice: 'qtypeMultichoice',
  truefalse: 'qtypeTruefalse',
  shortanswer: 'qtypeShortanswer',
  essay: 'qtypeEssay',
};

/** Mức độ nhận thức trên dòng nối câu hỏi × YCCĐ (issue #20 Chặng 2, mục A.2). */
export const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;
export const LEVEL_LABEL_KEYS: Record<(typeof COGNITIVE_LEVELS)[number], string> = {
  biet: 'levelBiet',
  hieu: 'levelHieu',
  van_dung: 'levelVanDung',
  van_dung_cao: 'levelVanDungCao',
};

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
export interface CurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Một node trong cây chương trình trả về bởi GET /curriculum/curricula/:id/tree. */
export interface CurriculumTreeNode {
  id: string;
  title: string;
  outcomes: { id: string; content: string }[];
  children: CurriculumTreeNode[];
}










/** Khoá học cho hộp thoại triển khai đề vào quiz. */
interface CourseLite {
  id: string;
  fullName: string;
}

/** Nhóm của khoá cho hộp thoại ghim đề (GET /courses/:id/groups). */
interface CourseGroupLite {
  id: string;
  name: string;
}

export function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/**
 * Nhãn hiển thị của một câu hỏi = TRÍCH ĐOẠN nội dung thân câu của
 * phiên bản mới nhất (tối đa 120 ký tự). Câu hỏi không còn trường tên
 * (quyết 11:28 ngày 26/10/2026) nên mọi bề mặt cần nhãn — danh sách,
 * hộp xác nhận xoá, bộ chọn, panel xem trước — đều dùng trích đoạn
 * này thay cho tên.
 *
 * @param view - View câu hỏi như API trả về.
 * @returns Chuỗi thuần trích từ thân câu.
 */
export function questionExcerpt(view: QuestionView): string {
  return plainText(view.latestVersion.questionText).slice(0, 120);
}

export type OptionsRecord = Record<string, unknown>;

/**
 * Các trường options phải còn nguyên khi sửa; thiếu trường nào thì form
 * sẽ tìm thêm ở endpoint versions. Multichoice chỉ còn các trường của
 * mô hình mới — `single`, `showNumCorrect` và `partiallyCorrectFeedback`
 * đã bỏ hẳn cùng tỉ trọng đáp án (quyết 12:04 + điểm quyết D-5 ngày
 * 26/10/2026).
 */
const OPTION_KEYS_BY_QTYPE: Record<Qtype, string[]> = {
  multichoice: [
    'shuffleAnswers',
    'answerNumbering',
    'showStandardInstruction',
    'correctFeedback',
    'incorrectFeedback',
  ],
  truefalse: ['showStandardInstruction'],
  shortanswer: ['useCase'],
  essay: [
    'responseFormat',
    'responseRequired',
    'responseFieldLines',
    'minWordLimit',
    'maxWordLimit',
    'graderInfo',
    'responseTemplate',
  ],
};

export function hasAllOptions(qtype: Qtype, options: OptionsRecord | null | undefined): boolean {
  if (!options) return false;
  return OPTION_KEYS_BY_QTYPE[qtype].every(
    (key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined,
  );
}

/**
 * Ngân hàng câu hỏi: các danh mục, các câu hỏi với huy hiệu phiên bản HIỆN TẠI
 * của chúng, tạo/sửa. Việc sửa tạo một phiên bản mới phía server — huy hiệu
 * tăng lên và lịch sử phiên bản hiển thị mọi phiên bản (các lượt làm đã
 * bắt đầu giữ phiên bản chúng đã ghim; bất biến đó nằm phía API).
 */
/**
 * Khu vực ngân hàng mà trang này đang phục vụ (chuẩn đường dẫn, issue
 * #221 — lát R1): mỗi khu vực có PATH RIÊNG, trang suy ra khu vực từ
 * route (prop do route module truyền vào), KHÔNG còn đọc ?bank=/
 * ?section= từ URL như trước. URL cũ dạng ?bank=... được lớp tương
 * thích ở route module questions chuyển hướng (replace) sang path mới.
 */
export type BankArea =
  | 'my-questions'
  | 'stimuli'
  | 'my-exams'
  | 'my-matrices'
  | 'system-questions'
  | 'system-exams'
  | 'system-matrices';

export function QuestionsPage({ area = 'my-questions' }: { area?: BankArea }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  // Client theo context (root gắn singleton phía client; test gắn
  // client riêng) — invalidate/fetchQuery phải đi qua client này.
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [versionsOf, setVersionsOf] = useState<{
    questionId: string;
    versions: { version: number; questionText: RichTextDocument }[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [qCategory, setQCategory] = useState('');
  const [stimulusContent, setStimulusContent] = useState('');
  const [editingStimulus, setEditingStimulus] = useState<StimulusView | null>(null);
  const [loading, setLoading] = useState(true);
  // Dữ liệu trang qua TanStack (F-01 đợt 1): danh mục + câu hỏi/ngữ
  // liệu theo danh mục là các query theo khoá factory (clientLoader
  // của route module đã prefetch); vai không có capability ngân
  // hàng thì không query nào chạy (giữ chặn theo vai như trước).
  const bankGate = perms.ready && perms.canUseQuestionBank;
  const categoriesQuery = useQuestionCategories(bankGate);
  const categories = categoriesQuery.data ?? [];
  const questions = useCategoryQuestions(qCategory, bankGate).data ?? [];
  const stimuliQuery = useCategoryStimuli(qCategory, bankGate);
  const stimuli = stimuliQuery.data ?? [];

  useEffect(() => {
    if (!categoriesQuery.isPending) setLoading(false);
  }, [categoriesQuery.isPending]);

  useEffect(() => {
    if (categoriesQuery.isError) setMessage(t('questionBankLoadFailed'));
  }, [categoriesQuery.isError, categoriesQuery.errorUpdatedAt, t]);

  useEffect(() => {
    if (stimuliQuery.isError) setMessage(t('stimulusLoadFailed'));
  }, [stimuliQuery.isError, stimuliQuery.errorUpdatedAt, t]);

  useEffect(() => {
    if (categories.length && !qCategory) setQCategory(String(categories[0]!.id));
  }, [categories, qCategory]);
  // Lớp bank của feat Ngân hàng câu hỏi chung (issue #70): khu vực ngân
  // hàng riêng của giáo viên + khu vực Ngân hàng hệ thống (bank chung).
  const banks = useQuestionBanks('question').data ?? [];
  // (Không còn state mở/đóng cho các khu vực ngân hàng: từ chốt
  // 23:43 ngày 26/10/2026 — sổ quyết định mục B — danh sách của khu
  // vực render THẲNG trong trang, không bọc thẻ thu/mở nữa; mỗi
  // route chỉ render đúng khu vực của path đó.)
  const [attributions, setAttributions] = useState<Record<string, AttributionLite>>({});
  const [discBankId, setDiscBankId] = useState('');
  const [discKeyword, setDiscKeyword] = useState('');
  const [discQtype, setDiscQtype] = useState('');
  const [discResults, setDiscResults] = useState<DiscoveryItemLite[]>([]);
  const contributions = useBankQuestionContributions(discBankId).data ?? [];
  const [previewItem, setPreviewItem] = useState<QuestionView | null>(null);
  const [proposeQuestionId, setProposeQuestionId] = useState('');
  const [proposeBankId, setProposeBankId] = useState('');
  // Ngân hàng ma trận (MB-1, issue #111): khu riêng "Ma trận của tôi" +
  // section ma trận chung trong Ngân hàng hệ thống — cùng khuôn hai khu
  // vực phân biệt của ngân hàng câu hỏi.
  const matrixBanks = useQuestionBanks('matrix').data ?? [];
  const subjects = useCurriculumSubjects(true).data ?? [];
  const [sharedMatrixBankId, setSharedMatrixBankId] = useState('');
  const sharedMatrices = useBankMatrices(sharedMatrixBankId || undefined).data ?? [];
  const [matrixSubjectFilter, setMatrixSubjectFilter] = useState('');
  const matrixContributions = useBankMatrixContributions(sharedMatrixBankId).data ?? [];
  const [proposeMatrixId, setProposeMatrixId] = useState('');
  const [proposeMatrixBankId, setProposeMatrixBankId] = useState('');

  // Ngân hàng đề (EB-1, issue #113): bank đề dùng chung khuôn bank đa
  // loại (kind=exam); "Đề của tôi" là khu riêng song song "Ngân
  // hàng riêng của tôi" của câu hỏi, theo mô hình hai khu vực đã chốt.
  const examBanks = useQuestionBanks('exam').data ?? [];
  const [systemExamBankId, setSystemExamBankId] = useState('');
  const systemPapers = useBankExams(systemExamBankId || undefined).data ?? [];
  // Hàng chờ ĐÓNG GÓP đề của bank đang chọn — ĐƯỜNG ĐÓNG GÓP DUY NHẤT
  // của đề (S4/Q4 của issue #228): cả hai trạng thái chờ đều hành động
  // được ngay tại hàng chờ (pending = chờ duyệt cấp 1; pending_board =
  // chờ duyệt cấp 2 ban giám hiệu, chỉ có ở đóng góp kèm bộ hồ sơ khi
  // tenant bật cấp duyệt 2). Đóng góp CHUYỂN ĐỔI từ hồ sơ treo mang
  // `sourceDossierId` và được duyệt ngay tại hàng chờ hồ sơ (bề mặt
  // hiển thị của chúng) nên không lặp lại ở đây.
  const examContributions = useBankExamContributions(systemExamBankId).data ?? [];
  const paperContributions = examContributions.filter(
    (c) => !c.sourceDossierId && (c.status === 'pending' || c.status === 'pending_board'),
  );
  /** Neo hồ sơ gốc → đóng góp đã chuyển đổi từ hồ sơ đó (khoá thao tác duyệt của hàng chờ hồ sơ). */
  const contributionBySourceDossierId = new Map(
    examContributions.filter((c) => c.sourceDossierId).map((c) => [c.sourceDossierId!, c]),
  );
  const [proposePaperId, setProposePaperId] = useState('');
  const [proposePaperBankId, setProposePaperBankId] = useState('');
  // Bộ hồ sơ đề (EB-3, issue #165): hàng chờ của bank đích đang chọn,
  // danh sách bộ của chính giáo viên, form nộp bộ và bản đặc tả đang mở.
  // Sau Q4 bề mặt hồ sơ là CHỈ-ĐỌC (lịch sử): hàng chờ chỉ còn các bộ
  // đang chờ mà đóng góp liên kết (nếu đã chuyển đổi) cũng đang chờ —
  // bộ đã có kết quả duyệt ở phía đóng góp thì rời hàng chờ.
  const bankDossiers = (useBankDossiers(systemExamBankId).data ?? []).filter((d) => {
    if (d.status !== 'pending' && d.status !== 'pending_board') return false;
    const linked = contributionBySourceDossierId.get(d.id);
    return !linked || linked.status === 'pending' || linked.status === 'pending_board';
  });
  const myDossiers = useMyDossiers().data ?? [];
  const [dossierPaperId, setDossierPaperId] = useState('');
  const [dossierBankId, setDossierBankId] = useState('');
  const [openDossierSpec, setOpenDossierSpec] = useState<{ dossierId: string; spec: DossierSpecLite } | null>(null);
  // Bản đặc tả đang mở của một ĐÓNG GÓP kèm hồ sơ: đặc tả đã chụp nằm
  // ngay trong payload đóng góp (dossierSpecSnapshot) nên mở tại chỗ,
  // không gọi thêm endpoint như bề mặt hồ sơ lịch sử.
  const [openContributionSpec, setOpenContributionSpec] = useState<{ contributionId: string; spec: DossierSpecLite } | null>(null);
  const [deployPaper, setDeployPaper] = useState<PaperSummaryLite | null>(null);
  const deployCourses = useQuery({ ...coursesListQueryOptions(), enabled: !!deployPaper }).data ?? [];
  const [deployCourseId, setDeployCourseId] = useState('');
  const deployContentQuery = useQuery({
    ...courseContentQueryOptions(deployCourseId),
    enabled: !!deployCourseId,
  });
  const deploySections = deployContentQuery.data?.sections ?? [];
  const [deploySectionId, setDeploySectionId] = useState('');
  const deployGroups = useQuery({ ...courseGroupsQueryOptions(deployCourseId), enabled: !!deployCourseId }).data ?? [];
  const [deployGroupId, setDeployGroupId] = useState('');
  const [deployVariantCount, setDeployVariantCount] = useState('1');

  // Chọn chương đầu tiên khi nội dung khoá đích tải về (nhịp của
  // loadDeployQuizzes thủ công trước đây).
  useEffect(() => {
    if (deployContentQuery.data && !deploySectionId) {
      setDeploySectionId(deployContentQuery.data.sections[0]?.id ?? '');
    }
  }, [deployContentQuery.data, deploySectionId]);



  // Thông báo mang về từ màn sửa riêng (vd "Đã lưu thành phiên bản N…"
  // sau khi sửa câu hỏi) qua router state — giữ phản hồi lưu thành công
  // mà editor inline trước đây hiện ngay trên trang này.
  const location = useLocation();
  useEffect(() => {
    const notice = (location.state as { notice?: string } | null)?.notice;
    if (notice) setMessage(notice);
  }, [location.state]);

  // (Đã gỡ cơ chế đọc ?bank=/?section= để mở collapse + cuộn neo:
  // khu vực nay do PATH quyết định — xem BankArea ở đầu component.
  // URL cũ được lớp tương thích ở route module chuyển hướng sang.)



  const personalBank = banks.find((b) => b.scope === 'personal');
  const sharedBanks = banks.filter((b) => b.scope !== 'personal');
  const myQuestions = useMyBankQuestions(personalBank).data ?? [];

  const loadAttributionsFor = useCallback(async (views: QuestionView[]) => {
    const derived = views.filter(
      (v) => (v.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId,
    );
    for (const v of derived) {
      if (attributions[v.question.id]) continue;
      try {
        const a = await queryClient.fetchQuery(questionAttributionQueryOptions(v.question.id));
        setAttributions((prev) => ({ ...prev, [v.question.id]: a }));
      } catch {
        // Không có dòng ghi công thì thôi — không chặn danh sách.
      }
    }
  }, [attributions]);

  // Ghi công cho các câu copy trong bank cá nhân (trước đây do
  // loadMyQuestions gọi nối tiếp ngay sau khi nạp danh sách).
  useEffect(() => {
    if (myQuestions.length) void loadAttributionsFor(myQuestions);
  }, [myQuestions, loadAttributionsFor]);



  // --- ngân hàng ma trận (MB-1) -------------------------------------------------

  const personalMatrixBank = matrixBanks.find((b) => b.scope === 'personal');
  const sharedMatrixBanks = matrixBanks.filter((b) => b.scope !== 'personal');
  const myMatrices = useBankMatrices(personalMatrixBank?.id).data ?? [];





  /** Copy một ma trận chung về ngân hàng ma trận cá nhân (cầu nối hai khu vực, MB-1). */
  async function copyMatrixToMyBank(matrixId: string) {
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('matrixCopiedToMyBank'));
      refreshMatrixBanks();
    } catch {
      setMessage(t('matrixCopyFailed'));
    }
  }

  /** Xoá một ma trận của mình ngay tại dòng (§9). */
  async function deleteMyMatrix(matrixId: string) {
    if (!window.confirm(t('matrixDeleteConfirm'))) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}`, { method: 'DELETE' });
      setMessage(t('matrixDeleted'));
      refreshMatrixBanks();
    } catch {
      setMessage(t('matrixDeleteFailed'));
    }
  }

  /** Đề xuất đóng góp một ma trận ready của mình lên bank ma trận chung. */
  async function proposeMatrixToBank(matrixId: string, targetBankId: string) {
    if (!matrixId || !targetBankId) return;
    try {
      await apiJson(`/api/v1/exam-matrices/${matrixId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ targetBankId }),
      });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Duyệt/từ chối một đóng góp ma trận (từ chối hỏi lý do — bắt buộc). */
  async function reviewMatrixContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${contributionId}/approve`, {
          method: 'POST',
          body: '{}',
        });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${contributionId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      refreshSharedMatrices(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  const subjectName = (subjectId: string) => subjects.find((s) => s.id === subjectId)?.name ?? '';
  const matrixStatusKey = (status: string) => `matrixStatus${status[0]!.toUpperCase()}${status.slice(1)}`;
  /** Khoá i18n cho trạng thái chờ duyệt (EB-3): từ vựng trạng thái của hồ sơ và của đóng góp đề là một (pending/pending_board/approved/rejected) nên dùng chung — pending_board là khoá ghép riêng. */
  const dossierStatusKey = (status: string) =>
    status === 'pending_board'
      ? 'dossierStatusPendingBoard'
      : `dossierStatus${status[0]!.toUpperCase()}${status.slice(1)}`;
  const filteredSharedMatrices = sharedMatrices.filter(
    (m) =>
      !matrixSubjectFilter || m.subjectId === matrixSubjectFilter,
  );

  const personalExamBank = examBanks.find((b) => b.scope === 'personal');
  const sharedExamBanks = examBanks.filter((b) => b.scope !== 'personal');
  const myPapers = useBankExams(personalExamBank?.id).data ?? [];



  // Làm mới theo cụm sau mỗi đột biến: invalidate đúng khoá
  // factory của cụm (thay cho các hàm load* thủ công trước đây —
  // query đang hiển thị tự tải lại, các bề mặt khác dùng chung
  // khoá cũng được cập nhật).
  const refreshBanks = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.questionBanks('question') });
    if (personalBank) void queryClient.invalidateQueries({ queryKey: queryKeys.myBankQuestions(personalBank.id) });
  };
  const refreshMatrixBanks = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.questionBanks('matrix') });
    if (personalMatrixBank) void queryClient.invalidateQueries({ queryKey: queryKeys.bankMatrices(personalMatrixBank.id) });
  };
  const refreshExamBanks = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.questionBanks('exam') });
    if (personalExamBank) void queryClient.invalidateQueries({ queryKey: queryKeys.bankExams(personalExamBank.id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.myDossiers });
  };
  const refreshSharedMatrices = (bankId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankMatrices(bankId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankMatrixContributions(bankId) });
  };
  const refreshSystemPapers = (bankId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankExams(bankId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankExamContributions(bankId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankDossiers(bankId) });
  };
  const refreshMyDossiers = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.myDossiers });
  };
  const refreshContributions = (bankId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankQuestionContributions(bankId) });
  };
  const refreshCategoryQuestions = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.categoryQuestions(qCategory) });
  };
  const refreshCategoryStimuli = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.categoryStimuli(qCategory) });
  };

  /**
   * Nộp một BỘ HỒ SƠ: từ S4/Q4 (issue #228) bộ hồ sơ không còn là
   * đường riêng — thao tác này là ĐỀ XUẤT ĐÓNG GÓP kèm bộ hồ sơ đính
   * kèm (`withDossier: true`) trên ĐƯỜNG ĐÓNG GÓP DUY NHẤT của đề.
   * Phía API ghim bộ ba (version đề + version ma trận + bản đặc tả)
   * tại đúng lúc đề xuất và tính chống trùng như mọi đóng góp; duyệt
   * hai cấp đi theo trạng thái của chính đóng góp (`pending` →
   * `pending_board` khi tenant của bank đích bật cấp duyệt 2).
   */
  async function proposeDossier() {
    if (!dossierPaperId || !dossierBankId) return;
    try {
      await apiJson(`/api/v1/exams/banks/${dossierBankId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ examId: dossierPaperId, withDossier: true }),
      });
      setMessage(t('dossierProposedOk'));
      // Đóng góp mới thuộc hàng chờ của bank đích: làm tươi đúng cụm
      // khoá của bank đích (hàng đóng góp + bề mặt hồ sơ lịch sử).
      void queryClient.invalidateQueries({ queryKey: queryKeys.bankExamContributions(dossierBankId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.bankDossiers(dossierBankId) });
      refreshMyDossiers();
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  /**
   * Một mốc duyệt tại hàng chờ BỘ HỒ SƠ: hồ sơ là bề mặt CHỈ-ĐỌC
   * (lịch sử) — thao tác duyệt thật đi trên ĐÓNG GÓP đã chuyển đổi từ
   * chính hồ sơ đó, nối bằng `sourceDossierId` (đợt chuyển đổi hồ sơ
   * treo của Q4); cấp do trạng thái đóng góp quyết định: `pending` →
   * cấp 1 (approve/reject), `pending_board` → cấp 2 BGH
   * (board-approve/board-reject); từ chối bắt buộc lý do. Hồ sơ chưa
   * có đóng góp liên kết (chưa qua đợt chuyển đổi) thì không còn thao
   * tác ghi nào — đường ghi hồ sơ đã đóng (API trả 410).
   */
  async function reviewDossier(dossierId: string, action: 'approve' | 'reject' | 'board-approve' | 'board-reject') {
    const contribution = contributionBySourceDossierId.get(dossierId);
    if (!contribution || !systemExamBankId) return;
    try {
      if (action === 'approve' || action === 'board-approve') {
        await apiJson(`/api/v1/exams/banks/${systemExamBankId}/contributions/${contribution.id}/${action}`, { method: 'POST', body: '{}' });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/exams/banks/${systemExamBankId}/contributions/${contribution.id}/${action}`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      if (systemExamBankId) refreshSystemPapers(systemExamBankId);
      refreshMyDossiers();
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  /** Mở/đóng bản đặc tả ĐÃ CHỤP của một đóng góp kèm hồ sơ ngay trong hàng chờ đóng góp (đặc tả nằm sẵn trong payload đóng góp). */
  function toggleContributionSpec(contribution: ExamContributionLite) {
    if (openContributionSpec?.contributionId === contribution.id) { setOpenContributionSpec(null); return; }
    if (contribution.dossierSpecSnapshot) {
      setOpenContributionSpec({ contributionId: contribution.id, spec: contribution.dossierSpecSnapshot });
    }
  }

  /** Mở/đóng bản đặc tả ĐÃ CHỤP của bộ hồ sơ ngay trong hàng chờ. */
  async function toggleDossierSpec(dossierId: string) {
    if (openDossierSpec?.dossierId === dossierId) { setOpenDossierSpec(null); return; }
    try {
      const spec = await apiJson<DossierSpecLite>(`/api/v1/exams/dossiers/${dossierId}/specification`);
      setOpenDossierSpec({ dossierId, spec });
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  /** Tải bản đặc tả đã chụp của bộ hồ sơ ra file xlsx. */
  async function downloadDossierSpec(dossierId: string) {
    try {
      const res = await apiFetch(`/api/v1/exams/dossiers/${dossierId}/specification/export?format=xlsx`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ban-dac-ta.xlsx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  /** Copy một đề từ ngân hàng hệ thống về ngân hàng đề cá nhân (cầu nối hai khu vực cho ĐỀ). */
  async function copyPaperToMine(paperId: string) {
    try {
      await apiJson(`/api/v1/exams/${paperId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('paperCopiedToMyBank'));
      refreshExamBanks();
    } catch (err) {
      setMessage(withApiReason(t('examPaperCopyFailed'), err));
    }
  }

  async function setPaperStatus(paperId: string, status: 'ready' | 'hidden' | 'draft') {
    try {
      await apiJson(`/api/v1/exams/${paperId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
      refreshExamBanks();
      if (systemExamBankId) refreshSystemPapers(systemExamBankId);
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }

  async function deletePaper(paperId: string) {
    if (!window.confirm(t('examPaperDeleteConfirm'))) return;
    try {
      await apiJson(`/api/v1/exams/${paperId}`, { method: 'DELETE' });
      setMessage(t('examPaperDeleted'));
      refreshExamBanks();
    } catch (err) {
      setMessage(withApiReason(t('examPaperDeleteFailed'), err));
    }
  }

  /** Đề xuất một đề của tôi lên bank đề chung (khuôn QB-4 cho đơn vị đề; trường định danh theo hợp đồng là `examId`). */
  async function proposePaper() {
    if (!proposePaperId || !proposePaperBankId) return;
    try {
      await apiJson(`/api/v1/exams/banks/${proposePaperBankId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ examId: proposePaperId }),
      });
      setMessage(t('paperProposedOk'));
    } catch (err) {
      setMessage(withApiReason(t('proposeFailed'), err));
    }
  }

  /**
   * Một mốc duyệt của một đề xuất đóng góp đề tại bank đích: cấp 1
   * (approve/reject khi đóng góp `pending`) hoặc cấp 2 ban giám hiệu
   * (board-approve/board-reject khi đóng góp `pending_board` — chỉ
   * đóng góp kèm bộ hồ sơ mới lên được trạng thái này); từ chối ở cả
   * hai cấp đều bắt buộc lý do.
   */
  async function reviewPaperContribution(
    bankId: string,
    contributionId: string,
    action: 'approve' | 'reject' | 'board-approve' | 'board-reject',
  ) {
    try {
      if (action === 'approve' || action === 'board-approve') {
        await apiJson(`/api/v1/exams/banks/${bankId}/contributions/${contributionId}/${action}`, { method: 'POST', body: '{}' });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/exams/banks/${bankId}/contributions/${contributionId}/${action}`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      refreshSystemPapers(bankId);
    } catch (err) {
      setMessage(withApiReason(t('proposeFailed'), err));
    }
  }

  /** Mở hộp thoại GHIM: danh sách khoá học là query dùng chung khoá
   *  factory courses (bật khi hộp thoại mở); invalidate để danh sách
   *  tươi như nhịp tải lại mỗi lần mở trước đây. */
  function openDeploy(paper: PaperSummaryLite) {
    setDeployPaper(paper);
    setDeploySectionId('');
    setDeployGroupId('');
    void queryClient.invalidateQueries({ queryKey: queryKeys.courses });
  }

  /** Ghim đề vào khoá đã chọn (toàn khoá hoặc một nhóm đích) — một thao tác exam-pins. */
  async function runDeploy() {
    if (!deployPaper || !deployCourseId || !deploySectionId) return;
    try {
      const pin = await apiJson<{ id: string }>(`/api/v1/courses/${deployCourseId}/exam-pins`, {
        method: 'POST',
        body: JSON.stringify({
          sectionId: deploySectionId,
          examId: deployPaper.id,
          variantCount: Math.min(50, Math.max(1, Number(deployVariantCount) || 1)),
          ...(deployGroupId ? { targetGroupId: deployGroupId } : {}),
        }),
      });
      setMessage(t('pinOk', { version: deployPaper.latestVersion }));
      setDeployPaper(null);
      navigate(`/courses/${deployCourseId}/exams/${pin.id}`);
    } catch (err) {
      setMessage(withApiReason(t('pinFailed'), err));
    }
  }

  useEffect(() => {
    void loadAttributionsFor(questions);
  }, [questions, loadAttributionsFor]);

  async function runDiscovery() {
    try {
      const params = new URLSearchParams();
      if (discBankId) params.set('bankId', discBankId);
      if (discKeyword.trim()) params.set('keyword', discKeyword.trim());
      if (discQtype) params.set('qtype', discQtype);
      const rows = await queryClient.fetchQuery(questionDiscoveryQueryOptions(params.toString()));
      setDiscResults(rows);
    } catch {
      setDiscResults([]);
    }
  }

  /** Copy một câu về ngân hàng cá nhân của mình (cầu nối hai khu vực). */
  async function copyToMyBank(questionId: string) {
    try {
      await apiJson(`/api/v1/questions/${questionId}/copy`, { method: 'POST', body: '{}' });
      setMessage(t('copiedToMyBank'));
      refreshBanks();
    } catch {
      setMessage(t('copyFailed'));
    }
  }

  /** Đề xuất đóng góp một câu (của mình) lên một bank chung. */
  async function proposeToBank(questionId: string, targetBankId: string) {
    if (!targetBankId) return;
    try {
      await apiJson(`/api/v1/question-banks/${targetBankId}/contributions`, {
        method: 'POST',
        body: JSON.stringify({ questionId }),
      });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  async function reviewContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await apiJson(`/api/v1/question-banks/${bankId}/contributions/${contributionId}/approve`, { method: 'POST', body: '{}' });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/question-banks/${bankId}/contributions/${contributionId}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      }
      refreshContributions(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Xoá vật lý một câu của mình (API chặn khi câu đã được dùng — khi đó hãy rút câu). */
  async function deleteMyQuestion(questionId: string) {
    if (!window.confirm(t('deleteQuestionConfirm'))) return;
    try {
      await apiJson(`/api/v1/questions/${questionId}`, { method: 'DELETE' });
      setMessage(t('questionDeleted'));
      refreshBanks();
      refreshCategoryQuestions();
    } catch {
      setMessage(t('deleteFailed'));
    }
  }

  /** Rút / hoàn rút một câu khỏi bank của nó. */
  async function toggleWithdraw(view: QuestionView) {
    const status = (view.entry as { status?: string }).status;
    try {
      if (status === 'hidden') {
        await apiJson(`/api/v1/questions/${view.question.id}/restore`, { method: 'POST', body: '{}' });
        setMessage(t('questionRestored'));
      } else {
        const reason = window.prompt(t('withdrawQuestion')) ?? '';
        if (!reason.trim()) return;
        await apiJson(`/api/v1/questions/${view.question.id}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        setMessage(t('questionWithdrawn'));
      }
      refreshBanks();
      refreshCategoryQuestions();
    } catch {
      setMessage(t('proposeFailed'));
    }
  }


  /** Sửa một câu trong ngân hàng riêng: mở màn sửa riêng của câu đó. */
  function editMine(view: QuestionView) {
    navigate(`/questions/${view.question.id}/edit?category=${view.question.category}`);
  }

  async function submitStimulus(event: FormEvent) {
    event.preventDefault();
    if (editingStimulus) {
      try {
        await apiJson(`/api/v1/stimuli/${editingStimulus.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ content: stimulusContent }),
        });
        setEditingStimulus(null);
        setStimulusContent('');
        refreshCategoryStimuli();
      } catch {
        setMessage(t('stimulusSaveFailed'));
      }
      return;
    }
    try {
      await apiJson('/api/v1/stimuli', {
        method: 'POST',
        body: JSON.stringify({ categoryId: qCategory, content: stimulusContent }),
      });
      setStimulusContent('');
      refreshCategoryStimuli();
    } catch {
      setMessage(t('stimulusCreateFailed'));
    }
  }

  async function deleteStimulus(stimulus: StimulusView) {
    try {
      await apiJson(`/api/v1/stimuli/${stimulus.id}`, { method: 'DELETE' });
      if (editingStimulus?.id === stimulus.id) {
        setEditingStimulus(null);
        setStimulusContent('');
      }
      refreshCategoryStimuli();
    } catch {
      setMessage(t('stimulusDeleteFailed'));
    }
  }

  /**
   * Tạo lượt làm bài từ các câu hỏi đã chọn: slot chỉ cần `questionId`
   * (schema `questionUsageSlotSchema`) — server tự gắn phiên bản mới nhất
   * khi attempt bắt đầu, nên trang không gửi version id nào. Component
   * `mod_quiz` khớp cách API/e2e tạo usage cho một hoạt động quiz.
   */
  async function startUsageFromSelection() {
    try {
      const created = await apiJson<QuestionUsage>('/api/v1/question-usages', {
        method: 'POST',
        body: JSON.stringify({
          component: 'mod_quiz',
          slots: selected.map((questionId) => ({ questionId })),
        }),
      });
      await navigate(`/question-usages/${created.usage.id}`);
    } catch {
      setMessage(t('usageCreateFailed'));
    }
  }

  /** Xoá một câu hỏi qua DELETE /questions/:id sau khi xác nhận (§9: Xoá ngay tại dòng). */
  async function deleteQuestion(view: QuestionView) {
    if (!window.confirm(t('confirmDeleteQuestion', { name: questionExcerpt(view) }))) return;
    setMessage(null);
    try {
      await apiJson(`/api/v1/questions/${view.question.id}`, { method: 'DELETE' });
      setMessage(t('questionDeleted'));
      setSelected((prev) => prev.filter((qid) => qid !== view.question.id));
      refreshCategoryQuestions();
    } catch {
      setMessage(t('questionDeleteFailed'));
    }
  }

  async function showVersions(view: QuestionView) {
    const versions = await queryClient.fetchQuery(questionVersionsQueryOptions(view.question.id));
    setVersionsOf({ questionId: view.question.id, versions });
  }

  /** Nội dung ngữ liệu gắn với phiên bản mới nhất của câu hỏi (rỗng khi không gắn). */
  function stimulusTextOf(view: QuestionView): string {
    if (view.stimulus) return plainText(view.stimulus.content);
    const stimulusId = view.latestVersion.stimulusId;
    if (!stimulusId) return '';
    const found = stimuli.find((s) => s.id === stimulusId);
    return found ? plainText(found.content) : '';
  }

  /**
   * Cột của bảng ngân hàng câu hỏi trên DataTable dùng chung (TanStack
   * Table): chọn câu hỏi để làm bài vẫn là state của trang (checkbox ở
   * cột đầu ghi vào `selected`), trích đoạn nội dung/phiên bản sắp xếp
   * được, ô lọc toàn bảng quét theo trích đoạn và nội dung câu hỏi
   * (câu hỏi không còn trường tên — nhãn là trích đoạn, xem
   * `questionExcerpt`). Trước đây danh sách này là một <ul> tự chế
   * không sắp xếp/lọc/phân trang.
   */
  const questionColumns: DataColumn<QuestionView>[] = [
    {
      id: 'select',
      header: '',
      cell: (view) => (
        <Checkbox
          aria-label={t('selectQuestionForAttempt', { name: questionExcerpt(view) })}
          checked={selected.includes(view.question.id)}
          onCheckedChange={(checked) =>
            setSelected((prev) =>
              checked === true ? [...prev, view.question.id] : prev.filter((qid) => qid !== view.question.id),
            )
          }
        />
      ),
    },
    {
      id: 'excerpt',
      header: t('questionText'),
      cell: (view) => {
        // Dòng ghi công KHÔNG tắt được cho câu copy (QB-2): hiện ngay
        // dưới trích đoạn câu khi đã nạp được attribution; câu đã rút có nhãn.
        const a = attributions[view.question.id];
        const isCopy = Boolean((view.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId);
        return (
          <span>
            {questionExcerpt(view)}
            {(view.entry as { status?: string }).status === 'hidden' ? (
              <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('withdrawnBadge')}</span>
            ) : null}
            {isCopy && a ? (
              <span className="block text-xs text-muted-foreground">
                {t('copiedFromLine', { author: a.originalAuthorName ?? '—', bank: a.sourceBankName ?? '—' })}
              </span>
            ) : null}
          </span>
        );
      },
      sortValue: (view) => questionExcerpt(view),
      filterValue: (view) => questionExcerpt(view),
    },
    {
      id: 'qtype',
      header: t('questionType'),
      cell: (view) =>
        t(QTYPE_LABEL_KEYS[(QTYPES as readonly string[]).includes(view.question.qtype) ? (view.question.qtype as Qtype) : 'truefalse']),
      sortValue: (view) => view.question.qtype,
      filterValue: (view) => view.question.qtype,
    },
    {
      id: 'version',
      header: t('version'),
      cell: (view) => (
        <span data-testid={`version-badge-${view.question.id}`} className="rounded bg-secondary px-2 py-0.5 text-xs">
          v{view.entry.latestVersion}
        </span>
      ),
      sortValue: (view) => view.entry.latestVersion,
    },
    {
      id: 'text',
      header: t('questionText'),
      cell: (view) => (
        <span>
          <span className="text-sm text-muted-foreground">{plainText(view.latestVersion.questionText)}</span>
          {stimulusTextOf(view) ? (
            <span data-testid={`stimulus-of-${view.question.id}`} className="block text-sm">
              {t('stimulusPreview', { content: stimulusTextOf(view) })}
            </span>
          ) : null}
        </span>
      ),
      filterValue: (view) => `${plainText(view.latestVersion.questionText)} ${stimulusTextOf(view)}`,
    },
    {
      id: 'actions',
      header: t('actions'),
      cell: (view) => (
        <span className="flex gap-2">
          {/* §9: Sửa đi sang màn editor riêng; Xoá ngay tại dòng. */}
          <Button
            type="button"
            variant="outline"
            render={<Link to={`/questions/${view.question.id}/edit?category=${view.question.category}`} />}
          >
            {t('editNewVersion')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void showVersions(view)}>
            {t('history')}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void deleteQuestion(view)}>
            {t('deleteAction')}
          </Button>
          <Button
            type="button"
            variant="outline"
            title={t('copyToMyBankFull')}
            aria-label={t('copyToMyBankFull')}
            onClick={() => void copyToMyBank(view.question.id)}
          >
            {t('copyToMyBank')}
          </Button>
          <Button type="button" variant="outline" onClick={() => void toggleWithdraw(view)}>
            {(view.entry as { status?: string }).status === 'hidden' ? t('restoreQuestion') : t('withdrawQuestion')}
          </Button>
        </span>
      ),
    },
  ];

  /** Xem trước một câu trong trang khám phá ngân hàng chung. */
  async function previewDiscoveryItem(questionId: string) {
    try {
      const view = await queryClient.fetchQuery(questionDetailQueryOptions(questionId));
      setPreviewItem(view);
    } catch {
      setPreviewItem(null);
    }
  }

  // Chặn trang theo vai (issue #55 mục 1): sidebar đã ẩn mục điều hướng
  // với vai không có capability ngân hàng, trang chặn nốt khi vào thẳng
  // bằng URL — không render danh mục/câu hỏi/editor khi không có quyền.
  if (!perms.ready) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('loading')}
      </main>
    );
  }
  if (!perms.canUseQuestionBank) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Tiêu đề trang theo khu vực (chuẩn đường dẫn #221): tiêu đề là tên
  // ngân hàng của loại thực thể (Câu hỏi / Đề / Ma trận); khu vực Cá
  // nhân hay Hệ thống thể hiện bằng thanh tab ngay dưới tiêu đề (chốt
  // trình bày ngân hàng 11:40 ngày 26/10/2026, issue #228). Nút tạo
  // nằm ở PageHeader cho ĐỦ CẢ BA màn khu cá nhân (chốt 23:43 ngày
  // 26/10/2026 — sổ quyết định mục B): Câu hỏi giữ hai nút cũ (Danh
  // mục mới + Câu hỏi mới), Đề có "Đề mới", Ma trận có "Ma trận mới"
  // + "Nhập từ file"; khu Hệ thống không có nút tạo (chỉ xem/copy về).
  const isQuestionArea = area === 'my-questions' || area === 'stimuli';
  const headerTitle =
    area === 'my-exams' || area === 'system-exams'
      ? t('examBank')
      : area === 'my-matrices' || area === 'system-matrices'
        ? t('matrixBank')
        : t('questionBank');
  const headerDescription =
    area === 'my-exams'
      ? t('myExamBankDescription')
      : area === 'my-matrices'
        ? t('myMatrixBankDescription')
        : area.startsWith('system')
          ? t('systemBankDescription')
          : t('questionBankDescription');

  return (
    <PageShell width="full">
      <PageHeader
        title={headerTitle}
        description={headerDescription}
        actions={
          isQuestionArea ? (
            <>
              <Button type="button" variant="outline" render={<Link to="/questions/categories/new" />}>
                {t('newCategory')}
              </Button>
              <Button type="button" render={<Link to={`/questions/new?category=${qCategory}`} />}>
                {t('newQuestion')}
              </Button>
            </>
          ) : area === 'my-exams' ? (
            // Đích + điều kiện disabled giữ nguyên nút "Thêm mới" từng
            // nằm trong danh sách: cần id bank đề cá nhân để màn tạo
            // biết ghi vào bank nào; chưa có bank thì nút khoá.
            <Button
              type="button"
              disabled={!personalExamBank}
              onClick={() => personalExamBank && navigate(`/exams/new?bank=${personalExamBank.id}`)}
            >
              {t('newExam')}
            </Button>
          ) : area === 'my-matrices' ? (
            <>
              <Button type="button" onClick={() => navigate('/matrices/new')} disabled={!personalMatrixBank}>
                {t('newMatrix')}
              </Button>
              {/*
                Nút nhập từ file (I-3, issue #233): KHÔNG khoá theo
                personalMatrixBank như nút Ma trận mới — đường ghi I-2
                tự tạo lười bank ma trận cá nhân (ensurePersonalBank)
                nên giáo viên chưa có bank vẫn nhập được; cổng quyền
                thật nằm ở API (matrix:add tại môn) và ở trang
                import (canUseQuestionBank), không giấu nút ở đây.
              */}
              <Button type="button" variant="outline" onClick={() => navigate('/matrices/import')}>
                {t('matrixImportFromFile')}
              </Button>
            </>
          ) : undefined
        }
      />
      <BankAreaTabs area={area} />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {area === 'my-questions' ? (
        <>
      {/* Khu vực RIÊNG của giáo viên (feat #70 theo đính chính của Lão gia):
          tách hẳn khỏi Ngân hàng hệ thống. Danh sách câu của chính
          giáo viên hiện THẲNG trong trang, không bọc thẻ thu/mở —
          chốt 23:43 ngày 26/10/2026 (sổ quyết định mục B); nút tạo
          câu nằm ở PageHeader, không lặp trong danh sách. */}
      <div className="space-y-4">
            {myQuestions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {myQuestions.map((view) => {
                  const a = attributions[view.question.id];
                  const isCopy = Boolean(
                    (view.question as { derivedFromQuestionId?: string | null }).derivedFromQuestionId,
                  );
                  return (
                    <li key={view.question.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {questionExcerpt(view)}
                        {(view.entry as { status?: string }).status === 'hidden' ? (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('withdrawnBadge')}</span>
                        ) : null}
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{view.entry.latestVersion}</span>
                        {isCopy && a ? (
                          <span className="block text-xs text-muted-foreground">
                            {t('copiedFromLine', { author: a.originalAuthorName ?? '—', bank: a.sourceBankName ?? '—' })}
                          </span>
                        ) : null}
                      </span>
                      <Button type="button" variant="outline" onClick={() => editMine(view)}>
                        {t('editRow')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void toggleWithdraw(view)}>
                        {(view.entry as { status?: string }).status === 'hidden' ? t('restoreQuestion') : t('withdrawQuestion')}
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void deleteMyQuestion(view.question.id)}>
                        {t('deleteRow')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {sharedBanks.length > 0 && myQuestions.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="propose-question">{t('proposeToBank')}</Label>
                  <select
                    id="propose-question"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposeQuestionId}
                    onChange={(e) => setProposeQuestionId(e.target.value)}
                  >
                    <option value="">—</option>
                    {myQuestions.map((view) => (
                      <option key={view.question.id} value={view.question.id}>
                        {questionExcerpt(view)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="propose-bank">{t('pickBank')}</Label>
                  <select
                    id="propose-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposeBankId}
                    onChange={(e) => setProposeBankId(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Button
                  type="button"
                  disabled={!proposeQuestionId || !proposeBankId}
                  onClick={() => void proposeToBank(proposeQuestionId, proposeBankId)}
                >
                  {t('propose')}
                </Button>
              </div>
            ) : null}
      </div>
        </>
      ) : null}

      {area === 'my-matrices' ? (
        <>
      {/* Khu vực RIÊNG — Ma trận của tôi (MB-1, issue #111): phân
          biệt hẳn với Ngân hàng hệ thống. Danh sách ma trận của
          chính giáo viên hiện THẲNG trong trang, không bọc thẻ
          thu/mở — chốt 23:43 ngày 26/10/2026 (sổ quyết định mục
          B); nút Ma trận mới + Nhập từ file nằm ở PageHeader,
          Sửa/Xoá tại dòng. Dữ liệu nạp ngay khi vào trang qua các
          query của component (trước đây mở thẻ còn gọi
          refreshMatrixBanks — các đột biến trong trang vẫn tự
          refresh như cũ). */}
      <div className="space-y-4">
            {myMatrices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
            ) : (
              <ul className="space-y-2">
                {myMatrices.map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {m.name}
                      {m.isTemplate ? (
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('matrixTemplateBadge')}</span>
                      ) : null}
                      <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t(matrixStatusKey(m.status))}</span>
                      <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{m.version}</span>
                      <span className="block text-xs text-muted-foreground">
                        {subjectName(m.subjectId)} · {t('matrixCellsCount', { count: m.cells.length })}
                        {m.derivedFromMatrixId ? ` · ${t('matrixDerivedNote')}` : ''}
                      </span>
                    </span>
                    <Button type="button" variant="outline" onClick={() => navigate(`/matrices/${m.id}/edit`)}>
                      {t('editRow')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void deleteMyMatrix(m.id)}>
                      {t('deleteRow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {sharedMatrixBanks.length > 0 && myMatrices.some((m) => m.status === 'ready') ? (
              <div className="space-y-1">
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="propose-matrix">{t('proposeToBank')}</Label>
                    <select
                      id="propose-matrix"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={proposeMatrixId}
                      onChange={(e) => setProposeMatrixId(e.target.value)}
                    >
                      <option value="">—</option>
                      {myMatrices
                        .filter((m) => m.status === 'ready')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="propose-matrix-bank">{t('pickBank')}</Label>
                    <select
                      id="propose-matrix-bank"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={proposeMatrixBankId}
                      onChange={(e) => setProposeMatrixBankId(e.target.value)}
                    >
                      <option value="">—</option>
                      {sharedMatrixBanks.map((bank) => (
                        <option key={bank.id} value={bank.id}>
                          {bank.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    disabled={!proposeMatrixId || !proposeMatrixBankId}
                    onClick={() => void proposeMatrixToBank(proposeMatrixId, proposeMatrixBankId)}
                  >
                    {t('propose')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('matrixProposeHint')}</p>
              </div>
            ) : null}
      </div>
        </>
      ) : null}

      {area === 'my-exams' ? (
        <>
      {/* Khu vực "Đề của tôi" (EB-1): khu vực riêng của giáo viên
          cho ĐỀ — song song khu câu hỏi ở trên theo mô hình hai khu
          vực đã chốt. Danh sách đề của chính giáo viên hiện THẲNG
          trong trang, không bọc thẻ thu/mở — chốt 23:43 ngày
          26/10/2026 (sổ quyết định mục B); nút Đề mới nằm ở
          PageHeader, Sửa/Xoá tại dòng. */}
      <div className="space-y-4">
            {myPapers.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('examPaperEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {myPapers.map((paper) => (
                  <li key={paper.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1">
                      {paper.name}
                      <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                        {paper.status === 'ready'
                          ? t('examPaperStatusReady')
                          : paper.status === 'hidden'
                            ? t('examPaperStatusHidden')
                            : t('examPaperStatusDraft')}
                      </span>
                      <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{paper.latestVersion}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('examPaperSlotsCount', { count: paper.slotCount })}
                      </span>
                    </span>
                    <Button type="button" variant="outline" onClick={() => navigate(`/exams/${paper.id}/edit`)}>
                      {t('editRow')}
                    </Button>
                    {paper.status === 'draft' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'ready')}>
                        {t('examPaperMarkReady')}
                      </Button>
                    ) : null}
                    {paper.status === 'ready' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'hidden')}>
                        {t('examPaperHide')}
                      </Button>
                    ) : null}
                    {paper.status === 'hidden' ? (
                      <Button type="button" variant="outline" onClick={() => void setPaperStatus(paper.id, 'ready')}>
                        {t('examPaperRestore')}
                      </Button>
                    ) : null}
                    {paper.status === 'ready' && paper.capabilities.deploy ? (
                      <Button type="button" variant="outline" onClick={() => void openDeploy(paper)}>
                        {t('pinExamAction')}
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" onClick={() => void deletePaper(paper.id)}>
                      {t('deleteRow')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {deployPaper ? (
              <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                <div>
                  <Label htmlFor="deploy-course">{t('deployPickCourse')}</Label>
                  <select
                    id="deploy-course"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={deployCourseId}
                    onChange={(e) => {
                    setDeployCourseId(e.target.value);
                    setDeploySectionId('');
                    setDeployGroupId('');
                  }}
                  >
                    <option value="">—</option>
                    {deployCourses.map((c) => (
                      <option key={c.id} value={c.id}>{c.fullName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="deploy-section">{t('pinPickSection')}</Label>
                  <select
                    id="deploy-section"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={deploySectionId}
                    onChange={(e) => setDeploySectionId(e.target.value)}
                  >
                    <option value="">—</option>
                    {deploySections.map((sec) => (
                      <option key={sec.id} value={sec.id}>{sec.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="deploy-group">{t('pinPickGroup')}</Label>
                  <select
                    id="deploy-group"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={deployGroupId}
                    onChange={(e) => setDeployGroupId(e.target.value)}
                  >
                    <option value="">{t('pinExamWholeCourse')}</option>
                    {deployGroups.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="deploy-variants">{t('deployVariantCount')}</Label>
                  <Input
                    id="deploy-variants"
                    type="number"
                    min={1}
                    max={50}
                    className="w-24"
                    value={deployVariantCount}
                    onChange={(e) => setDeployVariantCount(e.target.value)}
                  />
                </div>
                <Button type="button" disabled={!deployCourseId || !deploySectionId} onClick={() => void runDeploy()}>
                  {t('pinExamAction')}
                </Button>
                <Button type="button" variant="outline" onClick={() => setDeployPaper(null)}>
                  ✕
                </Button>
              </div>
            ) : null}
            {sharedExamBanks.length > 0 && myPapers.length > 0 ? (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="propose-paper">{t('proposePaperToBank')}</Label>
                  <select
                    id="propose-paper"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposePaperId}
                    onChange={(e) => setProposePaperId(e.target.value)}
                  >
                    <option value="">—</option>
                    {myPapers.filter((p) => p.status === 'ready').map((paper) => (
                      <option key={paper.id} value={paper.id}>{paper.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="propose-paper-bank">{t('pickBank')}</Label>
                  <select
                    id="propose-paper-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={proposePaperBankId}
                    onChange={(e) => setProposePaperBankId(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedExamBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>{bank.name}</option>
                    ))}
                  </select>
                </div>
                <Button type="button" disabled={!proposePaperId || !proposePaperBankId} onClick={() => void proposePaper()}>
                  {t('propose')}
                </Button>
              </div>
            ) : null}
            {/* Nộp BỘ HỒ SƠ (EB-3): đề ready CÓ ma trận nộp theo cả bộ
                (ma trận + đề + đặc tả) vào bank tổ/trường. Từ S4/Q4
                thao tác này là đề xuất ĐÓNG GÓP kèm bộ hồ sơ đính kèm
                trên đường đóng góp duy nhất (xem proposeDossier);
                trạng thái và lý do từ chối theo dõi ở hàng chờ đóng
                góp/hồ sơ của bank đích và danh sách lịch sử dưới đây. */}
            {sharedExamBanks.length > 0 && myPapers.length > 0 ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="dossier-paper">{t('dossierPropose')}</Label>
                    <select
                      id="dossier-paper"
                      data-testid="dossier-paper-select"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={dossierPaperId}
                      onChange={(e) => setDossierPaperId(e.target.value)}
                    >
                      <option value="">—</option>
                      {myPapers.filter((p) => p.status === 'ready').map((paper) => (
                        <option key={paper.id} value={paper.id}>{paper.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="dossier-bank">{t('pickBank')}</Label>
                    <select
                      id="dossier-bank"
                      data-testid="dossier-bank-select"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                      value={dossierBankId}
                      onChange={(e) => setDossierBankId(e.target.value)}
                    >
                      <option value="">—</option>
                      {sharedExamBanks.map((bank) => (
                        <option key={bank.id} value={bank.id}>{bank.name}</option>
                      ))}
                    </select>
                  </div>
                  <Button
                    type="button"
                    data-testid="dossier-submit-button"
                    disabled={!dossierPaperId || !dossierBankId}
                    onClick={() => void proposeDossier()}
                  >
                    {t('dossierPropose')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('dossierProposeHint')}</p>
              </div>
            ) : null}
            <div className="space-y-2">
              <h4 className="font-medium">{t('dossierMine')}</h4>
              {myDossiers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('dossierEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {myDossiers.map((d) => {
                    const rejection = [...d.reviews].reverse().find((r) => r.decision === 'rejected');
                    return (
                      <li key={d.id} className="flex flex-wrap items-center gap-2" data-testid="my-dossier-row">
                        <span className="min-w-0 flex-1">
                          {d.examName ?? d.examId}
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                            {t(dossierStatusKey(d.status))}
                          </span>
                          {d.examVersionNumber !== null ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {t('dossierPinned', { paperVersion: d.examVersionNumber, matrixVersion: d.matrixVersion ?? '—' })}
                            </span>
                          ) : null}
                          {d.status === 'rejected' && rejection?.reason ? (
                            <span className="block text-xs text-destructive">
                              {t('dossierRejectedReason', { reason: rejection.reason })}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
      </div>
        </>
      ) : null}

      {area.startsWith('system') ? (
        <>
      {/* Khu vực Ngân hàng hệ thống: ba ngân hàng CHUNG (câu hỏi /
          đề / ma trận) — cả ba đã thi công: câu hỏi chung (feat
          #70), đề chung (EB-1, issue #113), ma trận chung (MB-1,
          issue #111). Mỗi trang /system-bank/* chỉ render đúng phần
          của nó (chuẩn đường dẫn #221 — trước đây cả ba phần chung
          một trang, sidebar cuộn neo tới từng phần) và phần đó hiện
          THẲNG trong trang, không bọc thẻ thu/mở — chốt 23:43 ngày
          26/10/2026 (sổ quyết định mục B) áp cùng khuôn với khu cá
          nhân. Các neo #system-* trên từng <section> giữ nguyên. */}
      <div className="space-y-6">
            {area === 'system-questions' ? (
            <section id="system-questions" className="space-y-3 scroll-mt-24">
              <h3 className="font-medium">{t('sharedQuestionBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="disc-bank">{t('pickBank')}</Label>
                  <select
                    id="disc-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={discBankId}
                    onChange={(e) => {
                      setDiscBankId(e.target.value);
                    }}
                  >
                    <option value="">{t('allSharedBanks')}</option>
                    {sharedBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="disc-keyword">{t('discoveryKeyword')}</Label>
                  <Input
                    id="disc-keyword"
                    value={discKeyword}
                    onChange={(e) => setDiscKeyword(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="disc-qtype">{t('questionType')}</Label>
                  <select
                    id="disc-qtype"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={discQtype}
                    onChange={(e) => setDiscQtype(e.target.value)}
                  >
                    <option value="">—</option>
                    {QTYPES.map((qtype) => (
                      <option key={qtype} value={qtype}>
                        {t(QTYPE_LABEL_KEYS[qtype])}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="button" onClick={() => void runDiscovery()}>
                  {t('discoverySearch')}
                </Button>
              </div>
              {discResults.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('discoveryEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {discResults.map((item) => (
                    <li key={item.questionId} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {item.excerpt}
                        <span className="block text-xs text-muted-foreground">
                          {item.bankName} · {item.authorName ?? '—'} · {t('usedTimes', { count: item.useCount })} ·{' '}
                          {t('copiedTimes', { count: item.copyCount })}
                        </span>
                      </span>
                      <Button type="button" variant="outline" onClick={() => void previewDiscoveryItem(item.questionId)}>
                        {t('previewQuestion')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        title={t('copyToMyBankFull')}
                        aria-label={t('copyToMyBankFull')}
                        onClick={() => void copyToMyBank(item.questionId)}
                      >
                        {t('copyToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {previewItem ? (
                <div className="rounded-md border p-3">
                  <p className="font-medium">{questionExcerpt(previewItem)}</p>
                  <p className="text-sm text-muted-foreground">{plainText(previewItem.latestVersion.questionText)}</p>
                </div>
              ) : null}
              {discBankId ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('contributionQueue')}</h4>
                  {contributions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('contributionEmpty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {contributions.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {c.questionName ?? c.questionId}
                            <span className="block text-xs text-muted-foreground">
                              {t('contributionBy', { name: c.proposerName ?? '—' })}
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewContribution(discBankId, c.id, true)}
                          >
                            {t('contributionApprove')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewContribution(discBankId, c.id, false)}
                          >
                            {t('contributionReject')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
            ) : null}
            {area === 'system-exams' ? (
            <>
            {/* Ngân hàng đề chung (EB-1): chọn một bank đề chung → danh
                sách đề ready của bank đó + Copy về ngân hàng đề của tôi
                tại dòng; người duyệt của bank thấy hàng chờ đóng góp đề. */}
            <section id="system-papers" className="space-y-3 scroll-mt-24">
              <h3 className="font-medium">{t('sharedExamBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="exam-bank-pick">{t('pickBank')}</Label>
                  <select
                    id="exam-bank-pick"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={systemExamBankId}
                    onChange={(e) => setSystemExamBankId(e.target.value)}
                  >
                    <option value="">—</option>
                    {sharedExamBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {systemExamBankId && systemPapers.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('examPaperEmpty')}</p>
              ) : (
                <ul className="space-y-2">
                  {systemPapers.map((paper) => (
                    <li key={paper.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {paper.name}
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{paper.latestVersion}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('examPaperSlotsCount', { count: paper.slotCount })} · {t('copiedTimes', { count: paper.copyCount })}
                        </span>
                      </span>
                      {paper.capabilities.edit ? (
                        <Button type="button" variant="outline" onClick={() => navigate(`/exams/${paper.id}/edit`)}>
                          {t('editRow')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        title={t('copyToMyBankFull')}
                        aria-label={t('copyToMyBankFull')}
                        onClick={() => void copyPaperToMine(paper.id)}
                      >
                        {t('copyPaperToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {systemExamBankId && paperContributions.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('examContributionQueue')}</h4>
                  <ul className="space-y-2">
                    {paperContributions.map((c) => (
                      <li key={c.id} className="space-y-1" data-testid="exam-contribution-row">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {c.paperName ?? c.examId}
                            {c.status === 'pending_board' ? (
                              <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                                {t(dossierStatusKey(c.status))}
                              </span>
                            ) : null}
                            {c.dossierExamVersionNumber !== null ? (
                              <span className="block text-xs text-muted-foreground">
                                {t('dossierPinned', { paperVersion: c.dossierExamVersionNumber, matrixVersion: c.dossierMatrixVersion ?? '—' })}
                              </span>
                            ) : null}
                          </span>
                          {c.dossierSpecSnapshot ? (
                            <Button type="button" variant="outline" onClick={() => toggleContributionSpec(c)}>
                              {t('dossierViewSpec')}
                            </Button>
                          ) : null}
                          {c.status === 'pending_board' ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'board-approve')}
                              >
                                {t('dossierBoardApprove')}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'board-reject')}
                              >
                                {t('dossierBoardReject')}
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'approve')}
                              >
                                {t('contributionApprove')}
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'reject')}
                              >
                                {t('contributionReject')}
                              </Button>
                            </>
                          )}
                        </div>
                        {openContributionSpec?.contributionId === c.id ? (
                          <div className="rounded-md border p-3 text-sm" data-testid="contribution-spec-panel">
                            <p className="font-medium">
                              {t('dossierSpecTotals', {
                                count: openContributionSpec.spec.totals.totalQuestions,
                                score: openContributionSpec.spec.totals.totalScore,
                              })}
                            </p>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {openContributionSpec.spec.topics.flatMap((topic) =>
                                topic.nodes.flatMap((node) =>
                                  node.outcomes.flatMap((outcome) =>
                                    outcome.cells.map((cell, idx) => (
                                      <li key={idx}>
                                        {cell.cognitiveLevel} · {cell.questionCount} · {cell.cellScore}
                                        {cell.slotNumbers?.length
                                          ? ` · ${t('dossierSpecSlots', { slots: cell.slotNumbers.join(', ') })}`
                                          : ''}
                                      </li>
                                    )),
                                  ),
                                ),
                              )}
                            </ul>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {/* Hàng chờ BỘ HỒ SƠ (EB-3): bề mặt ĐỌC lịch sử của các
                  bộ đã nộp theo đường hồ sơ cũ — người duyệt mở bản
                  đặc tả đã chụp ngay tại hàng chờ. Thao tác DUYỆT đi
                  trên đóng góp đã chuyển đổi từ chính bộ hồ sơ (nối
                  bằng sourceDossierId): cấp 1 khi đóng góp `pending`,
                  cấp 2 (BGH) khi đóng góp `pending_board`; bộ chưa có
                  đóng góp liên kết thì chỉ còn xem/tải đặc tả. */}
              {systemExamBankId && bankDossiers.length > 0 ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('dossierQueue')}</h4>
                  <ul className="space-y-2">
                    {bankDossiers.map((d) => {
                      const linkedContribution = contributionBySourceDossierId.get(d.id);
                      return (
                      <li key={d.id} className="space-y-1" data-testid="dossier-queue-row">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {d.examName ?? d.examId}
                            <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">
                              {t(dossierStatusKey(d.status))}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {t('contributionBy', { name: d.proposerName ?? '—' })}
                              {d.examVersionNumber !== null
                                ? ` · ${t('dossierPinned', { paperVersion: d.examVersionNumber, matrixVersion: d.matrixVersion ?? '—' })}`
                                : ''}
                            </span>
                          </span>
                          <Button type="button" variant="outline" onClick={() => void toggleDossierSpec(d.id)}>
                            {t('dossierViewSpec')}
                          </Button>
                          <Button type="button" variant="outline" onClick={() => void downloadDossierSpec(d.id)}>
                            {t('dossierDownloadSpec')}
                          </Button>
                          {linkedContribution?.status === 'pending' ? (
                            <>
                              <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'approve')}>
                                {t('contributionApprove')}
                              </Button>
                              <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'reject')}>
                                {t('contributionReject')}
                              </Button>
                            </>
                          ) : linkedContribution?.status === 'pending_board' ? (
                            <>
                              <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'board-approve')}>
                                {t('dossierBoardApprove')}
                              </Button>
                              <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'board-reject')}>
                                {t('dossierBoardReject')}
                              </Button>
                            </>
                          ) : null}
                        </div>
                        {openDossierSpec?.dossierId === d.id ? (
                          <div className="rounded-md border p-3 text-sm" data-testid="dossier-spec-panel">
                            <p className="font-medium">
                              {t('dossierSpecTotals', {
                                count: openDossierSpec.spec.totals.totalQuestions,
                                score: openDossierSpec.spec.totals.totalScore,
                              })}
                            </p>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {openDossierSpec.spec.topics.flatMap((topic) =>
                                topic.nodes.flatMap((node) =>
                                  node.outcomes.flatMap((outcome) =>
                                    outcome.cells.map((cell, idx) => (
                                      <li key={idx}>
                                        {cell.cognitiveLevel} · {cell.questionCount} · {cell.cellScore}
                                        {cell.slotNumbers?.length
                                          ? ` · ${t('dossierSpecSlots', { slots: cell.slotNumbers.join(', ') })}`
                                          : ''}
                                      </li>
                                    )),
                                  ),
                                ),
                              )}
                            </ul>
                          </div>
                        ) : null}
                      </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </section>
            </>
            ) : null}
            {area === 'system-matrices' ? (
            <section id="system-matrices" className="space-y-3 scroll-mt-24">
              <h3 className="font-medium">{t('sharedMatrixBank')}</h3>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <Label htmlFor="shared-matrix-bank">{t('pickBank')}</Label>
                  <select
                    id="shared-matrix-bank"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={sharedMatrixBankId}
                    onChange={(e) => {
                      setSharedMatrixBankId(e.target.value);
                    }}
                  >
                    <option value="">—</option>
                    {sharedMatrixBanks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name} ({t(`bankScope${bank.scope[0]!.toUpperCase()}${bank.scope.slice(1)}`)})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="matrix-subject-filter">{t('matrixFilterSubject')}</Label>
                  <select
                    id="matrix-subject-filter"
                    className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs"
                    value={matrixSubjectFilter}
                    onChange={(e) => setMatrixSubjectFilter(e.target.value)}
                  >
                    <option value="">{t('matrixAllSubjects')}</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {!sharedMatrixBankId ? (
                <p className="text-sm text-muted-foreground">{t('discoveryEmpty')}</p>
              ) : filteredSharedMatrices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('dashboard:emptyTable')}</p>
              ) : (
                <ul className="space-y-2">
                  {filteredSharedMatrices.map((m) => (
                    <li key={m.id} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1">
                        {m.name}
                        {m.isTemplate ? (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t('matrixTemplateBadge')}</span>
                        ) : null}
                        <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-xs">{t(matrixStatusKey(m.status))}</span>
                        <span className="ml-2 rounded bg-secondary px-2 py-0.5 text-xs">v{m.version}</span>
                        <span className="block text-xs text-muted-foreground">
                          {subjectName(m.subjectId)} · {t('matrixCellsCount', { count: m.cells.length })}
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        title={t('copyToMyBankFull')}
                        aria-label={t('copyToMyBankFull')}
                        onClick={() => void copyMatrixToMyBank(m.id)}
                      >
                        {t('copyToMyBank')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {sharedMatrixBankId ? (
                <div className="space-y-2">
                  <h4 className="font-medium">{t('contributionQueue')}</h4>
                  {matrixContributions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('contributionEmpty')}</p>
                  ) : (
                    <ul className="space-y-2">
                      {matrixContributions.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 flex-1">
                            {c.matrixName ?? c.matrixId}
                            <span className="block text-xs text-muted-foreground">
                              {t('contributionBy', { name: c.proposerName ?? '—' })}
                            </span>
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewMatrixContribution(sharedMatrixBankId, c.id, true)}
                          >
                            {t('contributionApprove')}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void reviewMatrixContribution(sharedMatrixBankId, c.id, false)}
                          >
                            {t('contributionReject')}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </section>
            ) : null}
      </div>
        </>
      ) : null}

      {isQuestionArea ? (
        <>
      {/* §9: mỗi danh mục là một mục thu/mở — bấm vào thì hiện danh sách
          câu hỏi của chính danh mục đó ngay dưới. */}
      {categories.map((cat) => {
        const isActive = qCategory === String(cat.id);
        return (
          <CollapsibleSection
            key={cat.id}
            title={cat.name}
            open={isActive}
            onOpenChange={(open) => {
              if (open) {
                setQCategory(String(cat.id));
              }
            }}
            paddedContent={false}
          >
            {isActive ? (
              <>
                    <DataTable
                      data={questions}
                      columns={questionColumns}
                      labels={{
                        columns: t('dashboard:tableColumns'),
                        previous: t('dashboard:tablePrevious'),
                        next: t('dashboard:tableNext'),
                        empty: t('dashboard:emptyTable'),
                        filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
                        pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
                      }}
                      getRowId={(view) => view.question.id}
                      rowTestId={(view) => `question-${view.question.id}`}
                    />
                    <CardContent className="space-y-4">
                      <Button
                        type="button"
                        disabled={selected.length === 0}
                        onClick={() => void startUsageFromSelection()}
                      >
                        {t('startAttemptFromSelection')}
                      </Button>
                      {versionsOf && (
                        <div data-testid="version-history">
                          <h3 className="font-medium">{t('versionHistory')}</h3>
                          <ul>
                            {versionsOf.versions.map((v) => (
                              <li key={v.version}>
                                v{v.version} — {plainText(v.questionText)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </>
            ) : null}
          </CollapsibleSection>
        );
      })}
      {loading && categories.length === 0 ? (
        <div className="space-y-2" aria-label={t('loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}
        </>
      ) : null}

      {area === 'stimuli' ? (
      <Card id="stimuli" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>{t('stimuli')}</CardTitle>
          <CardDescription>{t('stimuliDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {stimuli.map((stimulus) => (
              <li key={stimulus.id} data-testid={`stimulus-row-${stimulus.id}`} className="flex items-start gap-2">
                <span className="flex-1 text-sm">{plainText(stimulus.content)}</span>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEditingStimulus(stimulus);
                    setStimulusContent(plainText(stimulus.content));
                  }}
                >
                  {t('editStimulus')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void deleteStimulus(stimulus)}>
                  {t('deleteStimulus')}
                </Button>
              </li>
            ))}
          </ul>
          <form onSubmit={(e) => void submitStimulus(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="stimulus-content">
                  {editingStimulus ? t('stimulusContent') : t('newStimulus')}
                </FieldLabel>
                <Textarea
                  id="stimulus-content"
                  rows={4}
                  value={stimulusContent}
                  onChange={(e) => setStimulusContent(e.target.value)}
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit">{editingStimulus ? t('saveStimulus') : t('createStimulus')}</Button>
                {editingStimulus && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditingStimulus(null);
                      setStimulusContent('');
                    }}
                  >
                    {t('cancelStimulusEdit')}
                  </Button>
                )}
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      ) : null}
    </PageShell>
  );
}

/**
 * Màn tạo danh mục câu hỏi RIÊNG theo chuẩn §9 (route
 * /questions/categories/new): trước đây form này nhồi ngay dưới danh
 * sách ngân hàng trong cùng một trang (§9: tạo mới là màn riêng, không
 * nhồi form vào danh sách). Ngữ cảnh vẫn là control Select của @lms/ui
 * chỉ liệt kê ngữ cảnh người dùng thật sự có question:managecategory
 * (issue #55 mục 2), mặc định ngữ cảnh hệ thống. Tạo xong quay về danh
 * sách ngân hàng (trang danh sách tự nạp lại khi mở).
 */
export function QuestionCategoryNewPage() {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const [catName, setCatName] = useState('');
  const [contextId, setContextId] = useState('');
  const [contextOptions, setContextOptions] = useState<ContextOption[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!perms.ready || !perms.canUseQuestionBank) return;
    let cancelled = false;
    void (async () => {
      try {
        const contexts = await apiJson<{ id: string; contextLevel: number; instanceId: string }[]>(
          '/api/v1/access/contexts',
        );
        const manageable = new Set(
          (perms.access?.contexts ?? [])
            .filter((c) => c.capabilities.includes('question:managecategory'))
            .map((c) => c.contextId),
        );
        const courseName = (instanceId: string) =>
          perms.courses.find((c) => c.course.id === instanceId)?.course.fullName;
        const options: ContextOption[] = contexts
          .filter((c) => c.contextLevel === 10 || c.contextLevel === 40 || c.contextLevel === 50)
          .filter((c) => perms.access?.isSiteAdmin || manageable.has(c.id))
          .map((c) => ({
            id: c.id,
            level: c.contextLevel,
            label:
              c.contextLevel === 10
                ? t('contextSystem')
                : c.contextLevel === 50
                  ? `${t('contextCourse')}: ${courseName(c.instanceId) ?? c.instanceId.slice(0, 8)}`
                  : `${t('contextCourseCategory')}: ${c.instanceId.slice(0, 8)}`,
          }));
        if (cancelled) return;
        setContextOptions(options);
        setContextId((prev) => prev || options.find((o) => o.level === 10)?.id || options[0]?.id || '');
      } catch {
        // Không tải được danh sách ngữ cảnh thì select để rỗng; nếu vẫn
        // gửi tạo danh mục, lỗi hiện lý do thật từ API (mục 3).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [perms.ready, perms.canUseQuestionBank, perms.access]);

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    try {
      await apiJson('/api/v1/questions/categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName, contextId: contextId }),
      });
      clearQuestionBankListCache(queryClient);
      navigate('/questions');
    } catch (err) {
      setMessage(withApiReason(t('categoryCreateFailedShort'), err));
    }
  }

  if (!perms.ready) {
    return (
      <PageShell width="medium">
        <PageHeader title={t('newCategory')} />
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
        <PageHeader title={t('newCategory')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
        <p>
          <Link to="/questions" className="text-sm underline">
            {t('backToQuestionBankList')}
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell width="medium">
      <PageHeader title={t('newCategory')} />
      {message ? (
        <Alert role="status">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent>
          <form onSubmit={(e) => void createCategory(e)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="qcat-name">{t('name')}</FieldLabel>
                <Input id="qcat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel id="qcat-context-label">{t('questionCategoryContext')}</FieldLabel>
                <Select
                  items={Object.fromEntries(contextOptions.map((option) => [option.id, option.label]))}
                  value={contextId === '' ? null : contextId}
                  onValueChange={(v) => setContextId(v ?? '')}
                >
                  <SelectTrigger aria-labelledby="qcat-context-label" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {contextOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex justify-end">
                <Button type="submit" disabled={!contextId}>
                  {t('createCategory')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      <p>
        <Link to="/questions" className="text-sm underline">
          {t('backToQuestionBankList')}
        </Link>
      </p>
    </PageShell>
  );
}

/** Một phiên bản câu hỏi như endpoint versions trả về (có stimulusId để tra ngữ liệu đã gắn). */
interface PinnedVersion {
  id: string;
  version: number;
  questionText: RichTextDocument;
  stimulusId: string | null;
}

/** Nội dung hiển thị của một attempt: đề của phiên bản đã pin + ngữ liệu gắn kèm (nếu có). */
interface PinnedContent {
  questionText: string;
  stimulusText: string | null;
}

/**
 * Lượt làm bài câu hỏi: thao tác theo trạng thái của usage và từng attempt
 * (bắt đầu usage/attempt, nộp câu trả lời, kết thúc attempt/usage). Sau mỗi
 * thao tác trang nạp lại usage từ API để hiển thị state/fraction mới nhất.
 * Behaviour mặc định là deferredfeedback: nộp chỉ ghi đáp án thành step,
 * điểm (fraction) chỉ chốt khi kết thúc attempt hoặc toàn bộ usage.
 */
export function QuestionUsagePage() {
  const { t } = useTranslation('app');
  const { id } = useParams();
  const perms = usePermissions();
  const [usage, setUsage] = useState<QuestionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pinned, setPinned] = useState<Record<string, PinnedContent>>({});

  /**
   * Nạp nội dung của phiên bản ĐÃ PIN cho từng attempt đã bắt đầu: usage chỉ
   * mang questionId/questionVersionId, nên đề và ngữ liệu phải tra qua
   * endpoint versions (đúng phiên bản đã pin, không phải bản mới nhất) rồi
   * endpoint stimuli. Lỗi ở bước phụ này không chặn thao tác làm bài.
   */
  const loadPinned = useCallback(async (fresh: QuestionUsage) => {
    const entries = await Promise.all(
      fresh.attempts
        .filter((a) => a.questionVersionId)
        .map(async (a) => {
          try {
            const versions = await apiJson<PinnedVersion[]>(`/api/v1/questions/${a.questionId}/versions`);
            const version = versions.find((v) => v.id === a.questionVersionId);
            if (!version) return null;
            let stimulusText: string | null = null;
            if (version.stimulusId) {
              const stimulus = await apiJson<StimulusView>(`/api/v1/stimuli/${version.stimulusId}`);
              stimulusText = plainText(stimulus.content);
            }
            return [a.id, { questionText: plainText(version.questionText), stimulusText }] as const;
          } catch {
            return null;
          }
        }),
    );
    setPinned((prev) => {
      const next = { ...prev };
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      return next;
    });
  }, []);

  /** Nạp (lại) usage hiện tại từ API — nguồn sự thật cho state/fraction. */
  const reload = useCallback(async () => {
    const fresh = await apiJson<QuestionUsage>(`/api/v1/question-usages/${id}`);
    setUsage(fresh);
    void loadPinned(fresh);
  }, [id, loadPinned]);

  useEffect(() => {
    // Trang làm thử thuộc bộ công cụ ngân hàng: cùng cổng vai với trang
    // ngân hàng (issue #55 mục 1); API usage cũng đã gác chủ sở hữu/quyền.
    if (!perms.ready || !perms.canUseQuestionBank) return;
    void reload().catch(() => setError(t('attemptLoadFailed')));
  }, [reload, t, perms.ready, perms.canUseQuestionBank]);

  /** Chạy một thao tác làm bài rồi nạp lại usage; lỗi hiện thân thiện qua i18n. */
  async function act(run: () => Promise<unknown>) {
    setActionError(null);
    try {
      await run();
      await reload();
    } catch {
      setActionError(t('usageActionFailed'));
    }
  }

  if (!perms.ready)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        {t('loading')}
      </main>
    );
  if (!perms.canUseQuestionBank)
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('questionBank')}</CardTitle>
            <CardDescription>{t('questionBankForbidden')}</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  if (error)
    return (
      <PageShell width="medium">
        <PageHeader title={t('questionAttemptTitle', { component: '' })} />
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setError(null);
              void reload().catch(() => setError(t('attemptLoadFailed')));
            }}
          >
            {t('retry')}
          </Button>
        </div>
      </PageShell>
    );
  if (!usage)
    return (
      <PageShell width="medium">
        <div className="space-y-2" aria-label={t('attemptLoading')}>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PageShell>
    );
  const usageId = usage.usage.id;
  const gradedStates = ['gradedright', 'gradedpartial', 'gradedwrong', 'gaveup'];
  return (
    <PageShell width="medium">
      <PageHeader
        title={t('questionAttemptTitle', { component: usage.usage.component })}
        description={t('usageState', { state: usage.state })}
      />
      <Card>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('deferredFeedbackNote')}</p>
          {actionError ? (
            <Alert variant="destructive">
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex gap-2">
            {usage.state === 'notstarted' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => apiJson(`/api/v1/question-usages/${usageId}/start`, { method: 'POST', body: '{}' }))
                }
              >
                {t('usageStart')}
              </Button>
            ) : null}
            {usage.state === 'inprogress' ? (
              <Button
                type="button"
                onClick={() =>
                  void act(() => apiJson(`/api/v1/question-usages/${usageId}/finish`, { method: 'POST', body: '{}' }))
                }
              >
                {t('usageFinish')}
              </Button>
            ) : null}
          </div>
          <ul className="space-y-4">
            {usage.attempts.map((a) => {
              const started = a.state !== 'notstarted';
              const finishedAttempt = gradedStates.includes(a.state);
              const lastAnswer = [...a.steps].reverse().find((s) => s.data.answer)?.data.answer ?? '';
              const content = pinned[a.id];
              return (
                <li key={a.id} data-testid={`attempt-${a.id}`} className="space-y-2">
                  <div>
                    {t('slotLine', { slot: a.slot })} <strong>{a.state}</strong>
                    {a.fraction !== null ? ` ${t('fractionSuffix', { fraction: a.fraction })}` : ''}
                    {a.questionVersionId ? ` ${t('pinnedVersionSuffix', { versionId: a.questionVersionId })}` : ''}
                    <span className="block text-sm text-muted-foreground">
                      {t('stepsLine', { steps: a.steps.map((s) => s.state).join(' → ') || t('stepsNone') })}
                    </span>
                  </div>
                  {content ? (
                    <div className="space-y-2">
                      {content.stimulusText ? (
                        <div data-testid={`attempt-stimulus-${a.id}`} className="rounded-md border p-3">
                          <h4 className="text-sm font-medium">{t('stimulusHeading')}</h4>
                          <p className="text-sm whitespace-pre-wrap">{content.stimulusText}</p>
                        </div>
                      ) : null}
                      <p className="text-sm whitespace-pre-wrap">{content.questionText}</p>
                    </div>
                  ) : null}
                  {!started ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void act(() =>
                          apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/start`, {
                            method: 'POST',
                            body: '{}',
                          }),
                        )
                      }
                    >
                      {t('attemptStart')}
                    </Button>
                  ) : null}
                  {started && !finishedAttempt ? (
                    <div className="space-y-2">
                      <Field>
                        <FieldLabel htmlFor={`answer-${a.id}`}>{t('answerForSlot', { slot: a.slot })}</FieldLabel>
                        <Input
                          id={`answer-${a.id}`}
                          value={answers[a.id] ?? lastAnswer}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [a.id]: e.target.value }))}
                        />
                      </Field>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          onClick={() =>
                            void act(() =>
                              apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/submit`, {
                                method: 'POST',
                                body: JSON.stringify({
                                  response: (answers[a.id] ?? lastAnswer).trim() ? (answers[a.id] ?? lastAnswer) : null,
                                }),
                              }),
                            )
                          }
                        >
                          {t('attemptSubmit')}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() =>
                            void act(() =>
                              apiJson(`/api/v1/question-usages/${usageId}/attempts/${a.id}/finish`, {
                                method: 'POST',
                                body: '{}',
                              }),
                            )
                          }
                        >
                          {t('attemptFinish')}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-4 text-sm">
            <Link to="/questions">{t('backToQuestionBank')}</Link>
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default QuestionsPage;
