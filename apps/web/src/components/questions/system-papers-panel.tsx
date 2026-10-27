/**
 * Panel đề chung trong khu vực Ngân hàng hệ thống: chọn một bank đề
 * chung → danh sách đề ready của bank đó (sao chép về bank đề cá
 * nhân tại dòng) + hàng chờ đóng góp đề của bank, nơi người duyệt xử
 * lý từng mốc duyệt hai cấp và mở bản đặc tả đã chụp của đóng góp
 * kèm hồ sơ ngay tại dòng. State chọn bank do TRANG giữ (hàng chờ bộ
 * hồ sơ bên dưới dùng chung bank đang chọn) nên panel nhận qua props;
 * danh sách đề của bank panel tự nạp qua hook của lib/questions-data.
 * Đột biến qua hook của lib; làm mới qua các hàm refresh của trang.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';

import {
  useBankExams,
  useCopyExamPaper,
  useReviewExamPaperContribution,
  type BankLite,
  type DossierSpecLite,
  type ExamContributionLite,
} from '#lib/questions-data';
import { dossierStatusKey, withApiReason } from './shared';

/** Props của panel đề chung. */
export interface SystemPapersPanelProps {
  /** Bank đề chung đang chọn (state của trang, dùng chung với hàng chờ bộ hồ sơ). */
  systemExamBankId: string;
  /** Đổi bank đề chung đang chọn. */
  setSystemExamBankId: (bankId: string) => void;
  /** Các bank đề chung để chọn bank đang xem. */
  sharedExamBanks: BankLite[];
  /** Hàng chờ đóng góp đề của bank đang chọn (trang suy ra từ đóng góp của bank). */
  paperContributions: ExamContributionLite[];
  /** Làm mới cụm bank đề + danh sách bank cá nhân + hồ sơ của tôi (hàm của trang). */
  refreshExamBanks: () => void;
  /** Làm mới cụm đề chung của một bank (hàm của trang). */
  refreshSystemPapers: (bankId: string) => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel đề chung (Ngân hàng hệ thống).
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Nội dung section đề chung: chọn bank + danh sách đề + hàng chờ đóng góp đề.
 */
export function SystemPapersPanel({
  systemExamBankId,
  setSystemExamBankId,
  sharedExamBanks,
  paperContributions,
  refreshExamBanks,
  refreshSystemPapers,
  setMessage,
}: SystemPapersPanelProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const copyPaperMutation = useCopyExamPaper();
  const reviewPaperContributionMutation = useReviewExamPaperContribution();
  const systemPapers = useBankExams(systemExamBankId || undefined).data ?? [];
  // Bản đặc tả đang mở của một ĐÓNG GÓP kèm hồ sơ: đặc tả đã chụp nằm
  // ngay trong payload đóng góp (dossierSpecSnapshot) nên mở tại chỗ,
  // không gọi thêm endpoint như bề mặt hồ sơ lịch sử.
  const [openContributionSpec, setOpenContributionSpec] = useState<{ contributionId: string; spec: DossierSpecLite } | null>(null);

  /** Copy một đề từ ngân hàng hệ thống về ngân hàng đề cá nhân (cầu nối hai khu vực cho ĐỀ). */
  async function copyPaperToMine(paperId: string) {
    try {
      await copyPaperMutation.mutateAsync(paperId);
      setMessage(t('paperCopiedToMyBank'));
      refreshExamBanks();
    } catch (err) {
      setMessage(withApiReason(t('examPaperCopyFailed'), err));
    }
  }

  /**
   * Một mốc duyệt của một đề xuất đóng góp đề tại bank đích: chỉ còn
   * một động từ `approve`/`reject` (issue #345, giai đoạn 2) — cấp 1
   * khi đóng góp `pending`, cấp 2 ban giám hiệu khi đóng góp
   * `pending_board` (chỉ đóng góp kèm bộ hồ sơ mới lên được trạng
   * thái này), do phía server phân biệt bằng trạng thái và quyền;
   * từ chối ở cả hai cấp đều bắt buộc lý do.
   */
  async function reviewPaperContribution(
    bankId: string,
    contributionId: string,
    action: 'approve' | 'reject',
  ) {
    try {
      if (action === 'approve') {
        await reviewPaperContributionMutation.mutateAsync({ bankId, contributionId, action });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await reviewPaperContributionMutation.mutateAsync({ bankId, contributionId, action, reason });
      }
      refreshSystemPapers(bankId);
    } catch (err) {
      setMessage(withApiReason(t('proposeFailed'), err));
    }
  }

  /** Mở/đóng bản đặc tả ĐÃ CHỤP của một đóng góp kèm hồ sơ ngay trong hàng chờ đóng góp (đặc tả nằm sẵn trong payload đóng góp). */
  function toggleContributionSpec(contribution: ExamContributionLite) {
    if (openContributionSpec?.contributionId === contribution.id) { setOpenContributionSpec(null); return; }
    if (contribution.dossierSpecSnapshot) {
      setOpenContributionSpec({ contributionId: contribution.id, spec: contribution.dossierSpecSnapshot });
    }
  }

  return (
    <>
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
                      onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'approve')}
                    >
                      {t('dossierBoardApprove')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void reviewPaperContribution(systemExamBankId, c.id, 'reject')}
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
    </>
  );
}
