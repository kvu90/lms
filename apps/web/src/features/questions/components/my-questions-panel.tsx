/**
 * Panel "Câu hỏi của tôi" của trang ngân hàng câu hỏi: danh sách câu
 * trong bank cá nhân của giáo viên (kèm huy hiệu phiên bản, huy hiệu
 * đã rút và dòng ghi công khi câu là bản sao) + form đề xuất đóng góp
 * một câu lên bank chung. Dữ liệu danh sách do trang nạp qua các hook
 * của lib/questions-data rồi truyền xuống; panel giữ state cục bộ của
 * form đề xuất, tự gọi các đột biến của lib/questions-data cho thao
 * tác tại dòng (sửa qua điều hướng sang màn sửa riêng, rút/hoàn rút,
 * xoá) và báo kết quả qua prop setMessage của trang; việc làm mới
 * danh sách sau đột biến đi qua hai hàm refresh của trang truyền
 * xuống (đúng cụm khoá như khi panel còn nằm trong trang).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { QuestionView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';

import { useDeleteBankQuestion, useProposeQuestionContribution, useRestoreQuestion, useWithdrawQuestion } from '../queries/questions';
import type { AttributionLite, BankLite } from '../types/questions';
import { questionExcerpt } from '../utils/shared';

/** Props của panel "Câu hỏi của tôi". */
export interface MyQuestionsPanelProps {
  /** Các câu trong bank cá nhân của giáo viên (trang nạp bằng hook useMyBankQuestions). */
  myQuestions: QuestionView[];
  /** Ghi công theo id câu (trang nạp nối tiếp cho các câu là bản sao). */
  attributions: Record<string, AttributionLite>;
  /** Các bank chung để chọn đích đề xuất đóng góp. */
  sharedBanks: BankLite[];
  /** Làm mới cụm bank câu hỏi + danh sách bank cá nhân (hàm của trang). */
  refreshBanks: () => void;
  /** Làm mới danh sách câu hỏi theo danh mục đang chọn (hàm của trang). */
  refreshCategoryQuestions: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel "Câu hỏi của tôi".
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Danh sách câu cá nhân + form đề xuất đóng góp.
 */
export function MyQuestionsPanel({
  myQuestions,
  attributions,
  sharedBanks,
  refreshBanks,
  refreshCategoryQuestions,
  setMessage,
}: MyQuestionsPanelProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const deleteQuestionMutation = useDeleteBankQuestion();
  const restoreQuestionMutation = useRestoreQuestion();
  const withdrawQuestionMutation = useWithdrawQuestion();
  const proposeQuestionMutation = useProposeQuestionContribution();
  const [proposeQuestionId, setProposeQuestionId] = useState('');
  const [proposeBankId, setProposeBankId] = useState('');

  /** Sửa một câu trong ngân hàng riêng: mở màn sửa riêng của câu đó. */
  function editMine(view: QuestionView) {
    navigate(`/questions/${view.question.id}/edit?category=${view.question.category}`);
  }

  /** Rút / hoàn rút một câu khỏi bank của nó. */
  async function toggleWithdraw(view: QuestionView) {
    const status = (view.entry as { status?: string }).status;
    try {
      if (status === 'hidden') {
        await restoreQuestionMutation.mutateAsync(view.question.id);
        setMessage(t('questionRestored'));
      } else {
        const reason = window.prompt(t('withdrawQuestion')) ?? '';
        if (!reason.trim()) return;
        await withdrawQuestionMutation.mutateAsync({ questionId: view.question.id, reason });
        setMessage(t('questionWithdrawn'));
      }
      refreshBanks();
      refreshCategoryQuestions();
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Xoá vật lý một câu của mình (API chặn khi câu đã được dùng — khi đó hãy rút câu). */
  async function deleteMyQuestion(questionId: string) {
    if (!window.confirm(t('deleteQuestionConfirm'))) return;
    try {
      await deleteQuestionMutation.mutateAsync(questionId);
      setMessage(t('questionDeleted'));
      refreshBanks();
      refreshCategoryQuestions();
    } catch {
      setMessage(t('deleteFailed'));
    }
  }

  /** Đề xuất đóng góp một câu (của mình) lên một bank chung. */
  async function proposeToBank(questionId: string, targetBankId: string) {
    if (!targetBankId) return;
    try {
      await proposeQuestionMutation.mutateAsync({ bankId: targetBankId, questionId });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  return (
    <>
  {/* Khu vực RIÊNG của giáo viên (feat #70 theo đính chính đã chốt):
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
  );
}
