import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { QuestionView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/card';
import { ErrorAlert } from '#components/error-alert';
import { useTranslation } from 'react-i18next';
import { BankAreaTabs } from '../components/bank-area-tabs';
import { CategoryBrowser } from '../components/questions/category-browser';
import { DiscoveryPanel } from '../components/questions/discovery-panel';
import { DossierQueuePanel } from '../components/questions/dossier-queue-panel';
import { MyMatricesPanel, SystemMatricesPanel } from '../components/questions/my-matrices-panel';
import { MyPapersPanel } from '../components/questions/my-papers-panel';
import { MyQuestionsPanel } from '../components/questions/my-questions-panel';
import { StimuliPanel } from '../components/questions/stimuli-panel';
import { SystemPapersPanel } from '../components/questions/system-papers-panel';
import { PageHeader, PageShell } from '../components/page-shell';
import '../i18n';
import { useQueryClient } from '@tanstack/react-query';
import { usePermissions } from '#lib/permissions';
import { queryKeys } from '#lib/query-keys';
import {
  questionAttributionQueryOptions,
  useBankDossiers,
  useBankExamContributions,
  useBankExams,
  useBankMatrices,
  useCategoryQuestions,
  useCategoryStimuli,
  useMyBankQuestions,
  useQuestionBanks,
  useQuestionCategories,
  type AttributionLite,
} from '#lib/questions-data';
import { useCurriculumSubjects } from '#lib/matrix-data';
import { type BankArea } from '../components/questions/shared';


export { QuestionCategoryNewPage } from '../components/questions/category-new-page';
export { QuestionUsagePage } from '../components/questions/usage-page';
export {
  COGNITIVE_LEVELS,
  hasAllOptions,
  LEVEL_LABEL_KEYS,
  plainText,
  QTYPE_LABEL_KEYS,
  QTYPES,
  questionExcerpt,
  withApiReason,
  type BankArea,
  type CurriculumLinksView,
  type CurriculumTreeNode,
  type OptionsRecord,
  type Qtype,
} from '../components/questions/shared';

/**
 * Ngân hàng câu hỏi: các danh mục, các câu hỏi với huy hiệu phiên bản HIỆN TẠI
 * của chúng, tạo/sửa. Việc sửa tạo một phiên bản mới phía server — huy hiệu
 * tăng lên và lịch sử phiên bản hiển thị mọi phiên bản (các lượt làm đã
 * bắt đầu giữ phiên bản chúng đã ghim; bất biến đó nằm phía API).
 */

export function QuestionsPage({ area = 'my-questions' }: { area?: BankArea }) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const perms = usePermissions();
  // Client theo context (root gắn singleton phía client; test gắn
  // client riêng) — invalidate/fetchQuery phải đi qua client này.
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [qCategory, setQCategory] = useState('');
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
  // Ngân hàng ma trận (MB-1, issue #111): khu riêng "Ma trận của tôi" +
  // section ma trận chung trong Ngân hàng hệ thống — cùng khuôn hai khu
  // vực phân biệt của ngân hàng câu hỏi.
  const matrixBanks = useQuestionBanks('matrix').data ?? [];
  const subjects = useCurriculumSubjects(true).data ?? [];

  // Ngân hàng đề (EB-1, issue #113): bank đề dùng chung khuôn bank đa
  // loại (kind=exam); "Đề của tôi" là khu riêng song song "Ngân
  // hàng riêng của tôi" của câu hỏi, theo mô hình hai khu vực đã chốt.
  const examBanks = useQuestionBanks('exam').data ?? [];
  const [systemExamBankId, setSystemExamBankId] = useState('');
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
    // Mỗi câu một lượt đọc độc lập: nạp SONG SONG rồi gộp vào state
    // một lần (bản cũ lặp await nối tiếp từng câu); câu nào lỗi thì
    // bỏ qua như trước — không có dòng ghi công thì thôi, không
    // chặn danh sách.
    const entries = await Promise.all(
      derived
        .filter((v) => !attributions[v.question.id])
        .map(async (v) => {
          try {
            const a = await queryClient.fetchQuery(questionAttributionQueryOptions(v.question.id));
            return [v.question.id, a] as const;
          } catch {
            return null;
          }
        }),
    );
    const loaded: [string, AttributionLite][] = entries.filter((entry) => entry !== null);
    if (loaded.length > 0) {
      setAttributions((prev) => ({ ...prev, ...Object.fromEntries(loaded) }));
    }
  }, [attributions, queryClient]);

  // Ghi công cho các câu copy trong bank cá nhân (trước đây do
  // loadMyQuestions gọi nối tiếp ngay sau khi nạp danh sách).
  useEffect(() => {
    if (myQuestions.length) void loadAttributionsFor(myQuestions);
  }, [myQuestions, loadAttributionsFor]);


  // --- ngân hàng ma trận (MB-1) -------------------------------------------------

  const personalMatrixBank = matrixBanks.find((b) => b.scope === 'personal');
  const sharedMatrixBanks = matrixBanks.filter((b) => b.scope !== 'personal');
  const myMatrices = useBankMatrices(personalMatrixBank?.id).data ?? [];


  const personalExamBank = examBanks.find((b) => b.scope === 'personal');
  const sharedExamBanks = examBanks.filter((b) => b.scope !== 'personal');
  const myPapers = useBankExams(personalExamBank?.id).data ?? [];


  // Làm mới theo cụm sau mỗi đột biến: invalidate đúng khoá
  // factory của cụm (thay cho các hàm load* thủ công trước đây —
  // query đang hiển thị tự tải lại, các bề mặt khác dùng chung
  // khoá cũng được cập nhật).
  // Thao tác ghi của trang qua các đột biến của lib/questions-data
  // (F-01 của rà soát #133): đột biến chỉ ghi, việc làm mới theo cụm
  // vẫn do các hàm refresh* dưới đây quyết định như bản thủ công.

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
  const refreshCategoryQuestions = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.categoryQuestions(qCategory) });
  };


  useEffect(() => {
    void loadAttributionsFor(questions);
  }, [questions, loadAttributionsFor]);


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
        <ErrorAlert>
          {message}
        </ErrorAlert>
      ) : null}

      {area === 'my-questions' ? (
        <MyQuestionsPanel
          myQuestions={myQuestions}
          attributions={attributions}
          sharedBanks={sharedBanks}
          refreshBanks={refreshBanks}
          refreshCategoryQuestions={refreshCategoryQuestions}
          setMessage={setMessage}
        />
      ) : null}

      {area === 'my-matrices' ? (
        <MyMatricesPanel
          myMatrices={myMatrices}
          sharedMatrixBanks={sharedMatrixBanks}
          subjects={subjects}
          refreshMatrixBanks={refreshMatrixBanks}
          setMessage={setMessage}
        />
      ) : null}

      {area === 'my-exams' ? (
        <MyPapersPanel
          myPapers={myPapers}
          sharedExamBanks={sharedExamBanks}
          systemExamBankId={systemExamBankId}
          refreshExamBanks={refreshExamBanks}
          refreshSystemPapers={refreshSystemPapers}
          refreshMyDossiers={refreshMyDossiers}
          setMessage={setMessage}
        />
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
              <DiscoveryPanel
                sharedBanks={sharedBanks}
                refreshBanks={refreshBanks}
                setMessage={setMessage}
              />
            ) : null}
            {area === 'system-exams' ? (
            <>
            {/* Ngân hàng đề chung (EB-1): chọn một bank đề chung → danh
                sách đề ready của bank đó + Copy về ngân hàng đề của tôi
                tại dòng; người duyệt của bank thấy hàng chờ đóng góp đề. */}
            <section id="system-papers" className="space-y-3 scroll-mt-24">
              <SystemPapersPanel
                systemExamBankId={systemExamBankId}
                setSystemExamBankId={setSystemExamBankId}
                sharedExamBanks={sharedExamBanks}
                paperContributions={paperContributions}
                refreshExamBanks={refreshExamBanks}
                refreshSystemPapers={refreshSystemPapers}
                setMessage={setMessage}
              />
              <DossierQueuePanel
                bankDossiers={bankDossiers}
                contributionBySourceDossierId={contributionBySourceDossierId}
                systemExamBankId={systemExamBankId}
                refreshSystemPapers={refreshSystemPapers}
                refreshMyDossiers={refreshMyDossiers}
                setMessage={setMessage}
              />
            </section>
            </>
            ) : null}
            {area === 'system-matrices' ? (
              <SystemMatricesPanel
                sharedMatrixBanks={sharedMatrixBanks}
                subjects={subjects}
                refreshMatrixBanks={refreshMatrixBanks}
                refreshSharedMatrices={refreshSharedMatrices}
                setMessage={setMessage}
              />
            ) : null}
      </div>
        </>
      ) : null}


      {isQuestionArea ? (
        <CategoryBrowser
          categories={categories}
          questions={questions}
          stimuli={stimuli}
          attributions={attributions}
          qCategory={qCategory}
          setQCategory={setQCategory}
          loading={loading}
          refreshBanks={refreshBanks}
          refreshCategoryQuestions={refreshCategoryQuestions}
          setMessage={setMessage}
        />
      ) : null}

      {area === 'stimuli' ? (
        <StimuliPanel stimuli={stimuli} qCategory={qCategory} setMessage={setMessage} />
      ) : null}
    </PageShell>
  );
}


/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default QuestionsPage;
