/**
 * Panel "Đề của tôi" của trang ngân hàng câu hỏi: danh sách đề trong
 * bank đề cá nhân của giáo viên (đổi trạng thái/xoá tại dòng, hộp ghim
 * đề vào khoá học), form đề xuất đóng góp một đề lên bank chung, form
 * nộp BỘ HỒ SƠ kèm đề xuất đóng góp và danh sách lịch sử hồ sơ của
 * chính giáo viên. Dữ liệu danh sách đề do trang nạp rồi truyền
 * xuống; các query phụ của hộp ghim (khoá học/chương/nhóm) và danh
 * sách hồ sơ của tôi là cục bộ của panel nên panel tự gọi hook. Đột
 * biến qua hook của lib/questions-data; làm mới sau đột biến qua các
 * hàm refresh của trang truyền xuống; ghim thành công điều hướng
 * thẳng tới màn đề của khoá đích.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { courseContentQueryOptions, coursesListQueryOptions } from '#features/course-builder/queries/course-builder';
import { courseGroupsQueryOptions } from '#features/progress-report/queries/progress-report';
import { queryKeys } from '#lib/query-keys';
import { queryKeys as questionsQueryKeys } from '../queries/keys';
import { useDeleteExamPaper, useDeployExamPin, useMyDossiers, useProposeExamDossierContribution, useProposeExamPaperContribution, useSetExamPaperStatus } from '../queries/questions';
import type { BankLite, PaperSummaryLite } from '../types/questions';
import { dossierStatusKey, withApiReason } from '../utils/shared';

/** Props của panel "Đề của tôi". */
export interface MyPapersPanelProps {
  /** Các đề trong bank đề cá nhân (trang nạp bằng hook useBankExams). */
  myPapers: PaperSummaryLite[];
  /** Các bank đề chung để chọn đích đề xuất đóng góp/nộp hồ sơ. */
  sharedExamBanks: BankLite[];
  /** Bank đề chung đang chọn ở khu vực hệ thống (đổi trạng thái đề làm mới cả cụm đó khi đã chọn). */
  systemExamBankId: string;
  /** Làm mới cụm bank đề + danh sách bank cá nhân + hồ sơ của tôi (hàm của trang). */
  refreshExamBanks: () => void;
  /** Làm mới cụm đề chung của một bank (hàm của trang). */
  refreshSystemPapers: (bankId: string) => void;
  /** Làm mới danh sách hồ sơ của tôi (hàm của trang). */
  refreshMyDossiers: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel "Đề của tôi".
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Danh sách đề cá nhân + hộp ghim + hai form đề xuất + lịch sử hồ sơ.
 */
export function MyPapersPanel({
  myPapers,
  sharedExamBanks,
  systemExamBankId,
  refreshExamBanks,
  refreshSystemPapers,
  refreshMyDossiers,
  setMessage,
}: MyPapersPanelProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const paperStatusMutation = useSetExamPaperStatus();
  const deletePaperMutation = useDeleteExamPaper();
  const proposePaperMutation = useProposeExamPaperContribution();
  const deployPinMutation = useDeployExamPin();
  const proposeDossierContributionMutation = useProposeExamDossierContribution();
  const [proposePaperId, setProposePaperId] = useState('');
  const [proposePaperBankId, setProposePaperBankId] = useState('');
  const myDossiers = useMyDossiers().data ?? [];
  const [dossierPaperId, setDossierPaperId] = useState('');
  const [dossierBankId, setDossierBankId] = useState('');
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

  async function setPaperStatus(paperId: string, status: 'ready' | 'hidden' | 'draft') {
    try {
      await paperStatusMutation.mutateAsync({ paperId, status });
      refreshExamBanks();
      if (systemExamBankId) refreshSystemPapers(systemExamBankId);
    } catch (err) {
      setMessage(withApiReason(t('examPaperSaveFailed'), err));
    }
  }

  async function deletePaper(paperId: string) {
    if (!window.confirm(t('examPaperDeleteConfirm'))) return;
    try {
      await deletePaperMutation.mutateAsync(paperId);
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
      await proposePaperMutation.mutateAsync({ bankId: proposePaperBankId, paperId: proposePaperId });
      setMessage(t('paperProposedOk'));
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
      const pin = await deployPinMutation.mutateAsync({
        courseId: deployCourseId,
        body: {
          sectionId: deploySectionId,
          examId: deployPaper.id,
          variantCount: Math.min(50, Math.max(1, Number(deployVariantCount) || 1)),
          ...(deployGroupId ? { targetGroupId: deployGroupId } : {}),
        },
      });
      setMessage(t('pinOk', { version: deployPaper.latestVersion }));
      setDeployPaper(null);
      navigate(`/courses/${deployCourseId}/exams/${pin.id}`);
    } catch (err) {
      setMessage(withApiReason(t('pinFailed'), err));
    }
  }

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
      await proposeDossierContributionMutation.mutateAsync({ bankId: dossierBankId, examId: dossierPaperId });
      setMessage(t('dossierProposedOk'));
      // Đóng góp mới thuộc hàng chờ của bank đích: làm tươi đúng cụm
      // khoá của bank đích (hàng đóng góp + bề mặt hồ sơ lịch sử).
      void queryClient.invalidateQueries({ queryKey: questionsQueryKeys.bankExamContributions(dossierBankId) });
      void queryClient.invalidateQueries({ queryKey: questionsQueryKeys.bankDossiers(dossierBankId) });
      refreshMyDossiers();
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  return (
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
  );
}
