/**
 * Panel duyệt câu hỏi theo danh mục của trang ngân hàng câu hỏi: mỗi
 * danh mục là một mục thu/mở (mục đang mở là danh mục đang chọn), bên
 * trong là bảng câu hỏi dùng chung (DataTable) với cột chọn câu để
 * bắt đầu lượt dùng, trích đoạn, loại, phiên bản, nội dung + ngữ liệu
 * và các thao tác tại dòng (sửa qua màn editor riêng, lịch sử phiên
 * bản, xoá, sao chép về bank cá nhân, rút/hoàn rút). Dữ liệu danh
 * mục/câu hỏi/ngữ liệu/ghi công do trang nạp rồi truyền xuống; panel
 * giữ state chọn câu + lịch sử phiên bản đang xem và tự gọi các đột
 * biến của lib/questions-data; làm mới qua các hàm refresh của trang.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import type { QuestionCategory, QuestionView, RichTextDocument, StimulusView } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { CardContent } from '@lms/ui/components/card';
import { Checkbox } from '@lms/ui/components/checkbox';
import { Skeleton } from '@lms/ui/components/skeleton';

import { useQueryClient } from '@tanstack/react-query';

import { questionVersionsQueryOptions, useCopyQuestionToMyBank, useCreateQuestionUsage, useDeleteBankQuestion, useRestoreQuestion, useWithdrawQuestion } from '../queries/questions';
import type { AttributionLite } from '../types/questions';
import { CollapsibleSection } from '#components/collapsible-section';
import { DataTable, type DataColumn } from '#components/data-table';
import { plainText, QTYPE_LABEL_KEYS, QTYPES, questionExcerpt, type Qtype } from '../utils/shared';

/** Props của panel duyệt câu hỏi theo danh mục. */
export interface CategoryBrowserProps {
  /** Các danh mục câu hỏi (trang nạp bằng hook useQuestionCategories). */
  categories: QuestionCategory[];
  /** Các câu của danh mục đang chọn (trang nạp bằng hook useCategoryQuestions). */
  questions: QuestionView[];
  /** Các ngữ liệu của danh mục đang chọn (trang nạp bằng hook useCategoryStimuli). */
  stimuli: StimulusView[];
  /** Ghi công theo id câu (trang nạp nối tiếp cho các câu là bản sao). */
  attributions: Record<string, AttributionLite>;
  /** Danh mục đang chọn (state của trang, dùng chung với panel ngữ liệu). */
  qCategory: string;
  /** Đổi danh mục đang chọn (mở một mục thu/mở khác). */
  setQCategory: (categoryId: string) => void;
  /** Đang tải danh mục lần đầu (hiện khung xương khi chưa có danh mục nào). */
  loading: boolean;
  /** Làm mới cụm bank câu hỏi + danh sách bank cá nhân (hàm của trang). */
  refreshBanks: () => void;
  /** Làm mới danh sách câu hỏi theo danh mục đang chọn (hàm của trang). */
  refreshCategoryQuestions: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel duyệt câu hỏi theo danh mục.
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Các mục thu/mở theo danh mục + bảng câu hỏi của danh mục đang mở.
 */
export function CategoryBrowser({
  categories,
  questions,
  stimuli,
  attributions,
  qCategory,
  setQCategory,
  loading,
  refreshBanks,
  refreshCategoryQuestions,
  setMessage,
}: CategoryBrowserProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copyQuestionMutation = useCopyQuestionToMyBank();
  const deleteQuestionMutation = useDeleteBankQuestion();
  const restoreQuestionMutation = useRestoreQuestion();
  const withdrawQuestionMutation = useWithdrawQuestion();
  const createUsageMutation = useCreateQuestionUsage();
  const [selected, setSelected] = useState<string[]>([]);
  const [versionsOf, setVersionsOf] = useState<{
    questionId: string;
    versions: { version: number; questionText: RichTextDocument }[];
  } | null>(null);

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

  /** Xoá một câu hỏi qua DELETE /questions/:id sau khi xác nhận (§9: Xoá ngay tại dòng). */
  async function deleteQuestion(view: QuestionView) {
    if (!window.confirm(t('confirmDeleteQuestion', { name: questionExcerpt(view) }))) return;
    setMessage(null);
    try {
      await deleteQuestionMutation.mutateAsync(view.question.id);
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

  /**
   * Tạo lượt làm bài từ các câu hỏi đã chọn: slot chỉ cần `questionId`
   * (schema `questionUsageSlotSchema`) — server tự gắn phiên bản mới nhất
   * khi attempt bắt đầu, nên trang không gửi version id nào. Component
   * `mod_quiz` khớp cách API/e2e tạo usage cho một hoạt động quiz.
   */
  async function startUsageFromSelection() {
    try {
      const created = await createUsageMutation.mutateAsync({
        component: 'mod_quiz',
        slots: selected.map((questionId) => ({ questionId })),
      });
      await navigate(`/question-usages/${created.usage.id}`);
    } catch {
      setMessage(t('usageCreateFailed'));
    }
  }

  return (
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
  );
}
