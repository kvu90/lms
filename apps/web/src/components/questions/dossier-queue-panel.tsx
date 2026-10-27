/**
 * Panel hàng chờ BỘ HỒ SƠ trong section đề chung (khu vực Ngân hàng
 * hệ thống): bề mặt đọc lịch sử của các bộ hồ sơ đang chờ của bank
 * đang chọn — người duyệt mở/tải bản đặc tả đã chụp ngay tại hàng
 * chờ; thao tác duyệt đi trên đóng góp đã chuyển đổi từ chính bộ hồ
 * sơ (trang truyền bản đồ nối hồ sơ → đóng góp xuống). Dữ liệu hàng
 * chờ do trang nạp và lọc; panel giữ state bản đặc tả đang mở, tự
 * nạp đặc tả qua query options của lib/questions-data và tải file
 * đặc tả xlsx qua apiFetch (thao tác tải file có sẵn của bề mặt này).
 * Làm mới sau duyệt qua các hàm refresh của trang truyền xuống.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@lms/ui/components/button';

import { useQueryClient } from '@tanstack/react-query';

import { apiFetch } from '#lib/api';
import {
  examDossierSpecQueryOptions,
  useReviewExamPaperContribution,
  type DossierSpecLite,
  type ExamContributionLite,
  type ExamDossierLite,
} from '#lib/questions-data';
import { dossierStatusKey, withApiReason } from './shared';

/** Props của panel hàng chờ bộ hồ sơ. */
export interface DossierQueuePanelProps {
  /** Các bộ hồ sơ đang chờ của bank đang chọn (trang nạp và lọc theo trạng thái đóng góp liên kết). */
  bankDossiers: ExamDossierLite[];
  /** Bản đồ hồ sơ gốc → đóng góp đã chuyển đổi từ hồ sơ đó (khoá thao tác duyệt). */
  contributionBySourceDossierId: Map<string, ExamContributionLite>;
  /** Bank đề chung đang chọn (state của trang). */
  systemExamBankId: string;
  /** Làm mới cụm đề chung của một bank (hàm của trang). */
  refreshSystemPapers: (bankId: string) => void;
  /** Làm mới danh sách hồ sơ của tôi (hàm của trang). */
  refreshMyDossiers: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel hàng chờ bộ hồ sơ.
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Khối hàng chờ bộ hồ sơ (chỉ hiện khi đã chọn bank và có bộ đang chờ).
 */
export function DossierQueuePanel({
  bankDossiers,
  contributionBySourceDossierId,
  systemExamBankId,
  refreshSystemPapers,
  refreshMyDossiers,
  setMessage,
}: DossierQueuePanelProps) {
  const { t } = useTranslation('app');
  const queryClient = useQueryClient();
  const reviewPaperContributionMutation = useReviewExamPaperContribution();
  const [openDossierSpec, setOpenDossierSpec] = useState<{ dossierId: string; spec: DossierSpecLite } | null>(null);

  /**
   * Một mốc duyệt tại hàng chờ BỘ HỒ SƠ: hồ sơ là bề mặt CHỈ-ĐỌC
   * (lịch sử) — thao tác duyệt thật đi trên ĐÓNG GÓP đã chuyển đổi từ
   * chính hồ sơ đó, nối bằng `sourceDossierId` (đợt chuyển đổi hồ sơ
   * treo của Q4); cấp do trạng thái đóng góp quyết định ở phía
   * server (issue #345, giai đoạn 2): `pending` → cấp 1,
   * `pending_board` → cấp 2 BGH, cùng gọi một động từ
   * `approve`/`reject`; từ chối bắt buộc lý do. Hồ sơ chưa
   * có đóng góp liên kết (chưa qua đợt chuyển đổi) thì không còn thao
   * tác ghi nào — đường ghi hồ sơ đã đóng (API trả 410).
   */
  async function reviewDossier(dossierId: string, action: 'approve' | 'reject') {
    const contribution = contributionBySourceDossierId.get(dossierId);
    if (!contribution || !systemExamBankId) return;
    try {
      if (action === 'approve') {
        await reviewPaperContributionMutation.mutateAsync({
          bankId: systemExamBankId,
          contributionId: contribution.id,
          action,
        });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await reviewPaperContributionMutation.mutateAsync({
          bankId: systemExamBankId,
          contributionId: contribution.id,
          action,
          reason,
        });
      }
      if (systemExamBankId) refreshSystemPapers(systemExamBankId);
      refreshMyDossiers();
    } catch (err) {
      setMessage(withApiReason(t('dossierFailed'), err));
    }
  }

  /** Mở/đóng bản đặc tả ĐÃ CHỤP của bộ hồ sơ ngay trong hàng chờ. */
  async function toggleDossierSpec(dossierId: string) {
    if (openDossierSpec?.dossierId === dossierId) { setOpenDossierSpec(null); return; }
    try {
      const spec = await queryClient.fetchQuery(examDossierSpecQueryOptions(dossierId));
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

  return (
    <>
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
                    <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'approve')}>
                      {t('dossierBoardApprove')}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => void reviewDossier(d.id, 'reject')}>
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
    </>
  );
}
