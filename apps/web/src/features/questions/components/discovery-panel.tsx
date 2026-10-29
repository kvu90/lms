/**
 * Panel khám phá ngân hàng câu hỏi chung (section "system-questions"
 * của khu vực Ngân hàng hệ thống): tìm câu theo bank/từ khoá/loại,
 * xem trước nội dung, sao chép một câu về bank cá nhân và hàng chờ
 * đóng góp câu của bank đang chọn để duyệt tại dòng. Toàn bộ state
 * của section là cục bộ (bank đang chọn, từ khoá, loại, kết quả tìm,
 * câu đang xem trước) nên panel tự giữ và tự nạp hàng chờ qua hook
 * của lib/questions-data; việc tìm chạy qua queryClient.fetchQuery
 * với query options của lib (đúng nhịp tải theo thao tác như khi còn
 * trong trang). Sao chép xong làm mới qua hàm refresh của trang.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { QuestionView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';

import { useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../queries/keys';
import { questionDetailQueryOptions, questionDiscoveryQueryOptions, useBankQuestionContributions, useCopyQuestionToMyBank, useReviewQuestionContribution } from '../queries/questions';
import type { BankLite, DiscoveryItemLite } from '../types/questions';
import { plainText, QTYPE_LABEL_KEYS, QTYPES, questionExcerpt } from '../utils/shared';

/** Props của panel khám phá ngân hàng câu hỏi chung. */
export interface DiscoveryPanelProps {
  /** Các bank câu hỏi chung để chọn phạm vi tìm + đích của hàng chờ đóng góp. */
  sharedBanks: BankLite[];
  /** Làm mới cụm bank câu hỏi + danh sách bank cá nhân (hàm của trang). */
  refreshBanks: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel khám phá ngân hàng câu hỏi chung.
 *
 * @param props - Dữ liệu, hàm làm mới và bộ báo thông báo của trang.
 * @returns Section khám phá: bộ lọc tìm + kết quả + xem trước + hàng chờ đóng góp câu.
 */
export function DiscoveryPanel({ sharedBanks, refreshBanks, setMessage }: DiscoveryPanelProps) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const copyQuestionMutation = useCopyQuestionToMyBank();
  const reviewContributionMutation = useReviewQuestionContribution();
  const [discBankId, setDiscBankId] = useState('');
  const [discKeyword, setDiscKeyword] = useState('');
  const [discQtype, setDiscQtype] = useState('');
  const [discResults, setDiscResults] = useState<DiscoveryItemLite[]>([]);
  const contributions = useBankQuestionContributions(discBankId).data ?? [];
  const [previewItem, setPreviewItem] = useState<QuestionView | null>(null);

  const refreshContributions = (bankId: string) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.bankQuestionContributions(bankId) });
  };

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
      await copyQuestionMutation.mutateAsync(questionId);
      setMessage(t('copiedToMyBank'));
      refreshBanks();
    } catch {
      setMessage(t('copyFailed'));
    }
  }

  async function reviewContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await reviewContributionMutation.mutateAsync({ bankId, contributionId, approve: true });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await reviewContributionMutation.mutateAsync({ bankId, contributionId, approve: false, reason });
      }
      refreshContributions(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  /** Xem trước một câu trong trang khám phá ngân hàng chung. */
  async function previewDiscoveryItem(questionId: string) {
    try {
      const view = await queryClient.fetchQuery(questionDetailQueryOptions(questionId));
      setPreviewItem(view);
    } catch {
      setPreviewItem(null);
    }
  }

  return (
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
  );
}
