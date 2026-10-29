/**
 * Hai panel ma trận của trang ngân hàng câu hỏi: "Ma trận của tôi"
 * (bank ma trận cá nhân của giáo viên + form đề xuất đóng góp) và
 * section ma trận chung trong khu vực Ngân hàng hệ thống (chọn bank
 * chung + lọc theo môn → danh sách ma trận, sao chép về bank cá nhân,
 * hàng chờ đóng góp để duyệt tại dòng). Panel "của tôi" nhận dữ liệu
 * trang đã nạp; panel hệ thống tự nạp danh sách + hàng chờ của bank
 * đang chọn qua các hook của lib/questions-data vì state chọn bank là
 * cục bộ của section. Đột biến đều qua hook của lib/questions-data;
 * làm mới sau đột biến qua các hàm refresh của trang truyền xuống.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';

import { SubjectLite } from '#features/matrices/types/matrix';
import { useBankMatrices, useBankMatrixContributions, useCopyMatrixToMyBank, useDeleteMatrix, useProposeMatrixContribution, useReviewMatrixContribution } from '../queries/questions';
import type { BankLite, MatrixLite } from '../types/questions';
import { matrixStatusKey } from '../utils/shared';

/** Props của panel "Ma trận của tôi". */
export interface MyMatricesPanelProps {
  /** Các ma trận trong bank ma trận cá nhân (trang nạp bằng hook useBankMatrices). */
  myMatrices: MatrixLite[];
  /** Các bank ma trận chung để chọn đích đề xuất đóng góp. */
  sharedMatrixBanks: BankLite[];
  /** Danh sách môn để hiển thị tên môn của ma trận. */
  subjects: SubjectLite[];
  /** Làm mới cụm bank ma trận + danh sách bank cá nhân (hàm của trang). */
  refreshMatrixBanks: () => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/** Props của panel ma trận chung (Ngân hàng hệ thống). */
export interface SystemMatricesPanelProps {
  /** Các bank ma trận chung để chọn bank đang xem. */
  sharedMatrixBanks: BankLite[];
  /** Danh sách môn để hiển thị tên môn + lọc ma trận theo môn. */
  subjects: SubjectLite[];
  /** Làm mới cụm bank ma trận + danh sách bank cá nhân (hàm của trang). */
  refreshMatrixBanks: () => void;
  /** Làm mới danh sách + hàng chờ đóng góp của một bank chung (hàm của trang). */
  refreshSharedMatrices: (bankId: string) => void;
  /** Báo thông báo kết quả lên khung trang. */
  setMessage: (message: string | null) => void;
}

/**
 * Panel "Ma trận của tôi".
 *
 * @param props - Dữ liệu, hàm làm mới và bộ báo thông báo của trang.
 * @returns Danh sách ma trận cá nhân + form đề xuất đóng góp.
 */
export function MyMatricesPanel({
  myMatrices,
  sharedMatrixBanks,
  subjects,
  refreshMatrixBanks,
  setMessage,
}: MyMatricesPanelProps) {
  const { t } = useTranslation('app');
  const navigate = useNavigate();
  const deleteMatrixMutation = useDeleteMatrix();
  const proposeMatrixMutation = useProposeMatrixContribution();
  const [proposeMatrixId, setProposeMatrixId] = useState('');
  const [proposeMatrixBankId, setProposeMatrixBankId] = useState('');

  const subjectName = (subjectId: string) => subjects.find((s) => s.id === subjectId)?.name ?? '';

  /** Xoá một ma trận của mình ngay tại dòng (§9). */
  async function deleteMyMatrix(matrixId: string) {
    if (!window.confirm(t('matrixDeleteConfirm'))) return;
    try {
      await deleteMatrixMutation.mutateAsync(matrixId);
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
      await proposeMatrixMutation.mutateAsync({ matrixId, targetBankId });
      setMessage(t('proposedOk'));
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  return (
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
  );
}

/**
 * Panel ma trận chung trong khu vực Ngân hàng hệ thống.
 *
 * @param props - Dữ liệu, các hàm làm mới và bộ báo thông báo của trang.
 * @returns Section ma trận chung: chọn bank + lọc môn + danh sách + hàng chờ đóng góp.
 */
export function SystemMatricesPanel({
  sharedMatrixBanks,
  subjects,
  refreshMatrixBanks,
  refreshSharedMatrices,
  setMessage,
}: SystemMatricesPanelProps) {
  const { t } = useTranslation('app');
  const copyMatrixMutation = useCopyMatrixToMyBank();
  const reviewMatrixContributionMutation = useReviewMatrixContribution();
  const [sharedMatrixBankId, setSharedMatrixBankId] = useState('');
  const sharedMatrices = useBankMatrices(sharedMatrixBankId || undefined).data ?? [];
  const [matrixSubjectFilter, setMatrixSubjectFilter] = useState('');
  const matrixContributions = useBankMatrixContributions(sharedMatrixBankId).data ?? [];

  const subjectName = (subjectId: string) => subjects.find((s) => s.id === subjectId)?.name ?? '';

  const filteredSharedMatrices = sharedMatrices.filter(
    (m) =>
      !matrixSubjectFilter || m.subjectId === matrixSubjectFilter,
  );

  /** Copy một ma trận chung về ngân hàng ma trận cá nhân (cầu nối hai khu vực, MB-1). */
  async function copyMatrixToMyBank(matrixId: string) {
    try {
      await copyMatrixMutation.mutateAsync(matrixId);
      setMessage(t('matrixCopiedToMyBank'));
      refreshMatrixBanks();
    } catch {
      setMessage(t('matrixCopyFailed'));
    }
  }

  /** Duyệt/từ chối một đóng góp ma trận (từ chối hỏi lý do — bắt buộc). */
  async function reviewMatrixContribution(bankId: string, contributionId: string, approve: boolean) {
    try {
      if (approve) {
        await reviewMatrixContributionMutation.mutateAsync({ bankId, contributionId, approve: true });
      } else {
        const reason = window.prompt(t('contributionReject')) ?? '';
        if (!reason.trim()) return;
        await reviewMatrixContributionMutation.mutateAsync({ bankId, contributionId, approve: false, reason });
      }
      refreshSharedMatrices(bankId);
    } catch {
      setMessage(t('proposeFailed'));
    }
  }

  return (
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
  );
}
