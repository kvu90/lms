import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@lms/ui/components/alert';
import { Button } from '@lms/ui/components/button';
import { PageHeader, PageShell } from '../page-shell';
import { ApiError } from '#lib/api';
import { queryClient } from '#lib/query-client';
import {
  curriculumTreeScopedQueryOptions,
  useCurriculumTreeScoped, useDeleteCurriculumNode, useDeleteCurriculumOutcome,
  type CurriculumTree, type CurriculumTreeNode,
} from '#lib/curriculum';
import { flattenProgramRows, ProgramGroupTable, type ProgramRow } from './program-group-table';
import { errorText } from './shared';

/**
 * Số dòng Nội dung trên một trang đọc cây chương trình. Văn bản in của
 * Bộ trình bày bảng Nội dung | Yêu cầu cần đạt liên tục và ngắt trang
 * theo khổ giấy (mỗi trang in chứa chừng chục dòng nội dung); bản số
 * hoá giữ đúng nhịp đọc đó: 10 dòng/trang, mạch bị cắt qua trang thì
 * lặp lại tiêu đề kèm dấu (tiếp). Phân trang chạy hoàn toàn phía
 * client — cây đã tải một lần, chuyển trang không gọi lại server.
 */
export const PROGRAM_PAGE_SIZE = 10;

/** Một nhóm trình bày: một mạch nội dung (hoặc nhóm không tên khi gốc cây không phải mạch) + các dòng của nó. */
interface ProgramGroup {
  key: string;
  title: string | null;
  groupNode: CurriculumTreeNode | null;
  rows: ProgramRow[];
}

/** Dựng các nhóm trình bày từ cây, giữ đúng thứ tự + đường đi như bản không phân trang. */
export function buildProgramGroups(tree: CurriculumTree): ProgramGroup[] {
  const groups: ProgramGroup[] = [];
  for (const root of tree.nodes) {
    const rows: ProgramRow[] = [];
    if (root.kind === 'strand') {
      // Node gốc là mạch nội dung → một bảng mang tên mạch.
      if (root.outcomes.length > 0) rows.push({ node: root, path: [] });
      for (const child of root.children) flattenProgramRows(child, [], rows);
      groups.push({ key: root.id, title: root.title, groupNode: root, rows });
    } else {
      // Node gốc khác (dataset không mang mạch) → bảng không tiêu đề nhóm.
      flattenProgramRows(root, [], rows);
      groups.push({ key: root.id, title: null, groupNode: null, rows });
    }
  }
  return groups;
}

/** Danh sách số trang hiển thị ở nút phân trang: gọn khi nhiều trang (1 … quanh trang hiện tại … cuối). */
function pageNumberItems(total: number, current: number): (number | 'gap')[] {
  if (total <= 12) return Array.from({ length: total }, (_, i) => i + 1);
  const wanted = new Set([1, 2, total - 1, total, current - 1, current, current + 1]);
  const nums = [...wanted].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = 0;
  for (const n of nums) {
    if (prev > 0 && n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}

/**
 * Nạp trước cây cho route cây chương trình (cùng khoá với truy vấn
 * của trang) — lỗi nạp bỏ qua, trang tự hiện trạng thái như thường.
 */
export async function adminCurriculumTreePageClientLoader({ params }: { params: { curriculumId?: string } }) {
  if (params.curriculumId) {
    await queryClient
      .ensureQueryData(curriculumTreeScopedQueryOptions(params.curriculumId, undefined))
      .catch(() => undefined);
  }
  return null;
}

export function AdminCurriculumTreePage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const [message, setMessage] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const groupsTopRef = useRef<HTMLDivElement>(null);

  // Cây đọc qua TanStack Query (F-01 của rà soát #133): lỗi 403 thì
  // trang hiện thông báo không có quyền; chưa có dữ liệu thì giữ
  // trạng thái đang tải như bản thủ công. Xoá node/YCCĐ đi qua đột
  // biến — cây tự làm mới nhờ làm-mới-khoá của đột biến.
  const treeQuery = useCurriculumTreeScoped(curriculumId ?? '', undefined, curriculumId !== undefined);
  const tree = treeQuery.data ?? null;
  const forbidden = treeQuery.error instanceof ApiError && treeQuery.error.problem.status === 403;
  const deleteNodeMutation = useDeleteCurriculumNode();
  const deleteOutcomeMutation = useDeleteCurriculumOutcome();

  async function deleteNode(node: CurriculumTreeNode) {
    if (!window.confirm(t('curriculumConfirmDeleteNode', { title: node.title }))) return;
    try {
      await deleteNodeMutation.mutateAsync(node.id);
      setMessage(t('curriculumNodeDeleted'));
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  async function deleteOutcome(_node: CurriculumTreeNode, outcomeId: string) {
    if (!window.confirm(t('curriculumConfirmDeleteOutcome'))) return;
    try {
      await deleteOutcomeMutation.mutateAsync(outcomeId);
      setMessage(t('curriculumOutcomeDeleted'));
    } catch (err) {
      setMessage(errorText(err, t('curriculumDeleteFailed')));
    }
  }

  if (forbidden) {
    return (
      <PageShell>
        <Alert variant="destructive">
          <AlertDescription>{t('curriculumForbidden')}</AlertDescription>
        </Alert>
      </PageShell>
    );
  }
  if (!tree) {
    return (
      <PageShell>
        <p className="text-sm text-muted-foreground">{t('curriculumLoading')}</p>
      </PageShell>
    );
  }

  // Phân trang theo dòng Nội dung trên toàn cây: các mạch giữ nguyên
  // thứ tự, trang cắt đến đâu thì mạch đang dở được trình bày tiếp ở
  // trang sau với tiêu đề lặp lại kèm dấu (tiếp). Mạch chưa có dòng nào
  // vẫn hiện tiêu đề (giữ nút Thêm node con) ở trang chứa vị trí của nó.
  const groups = buildProgramGroups(tree);
  const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / PROGRAM_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PROGRAM_PAGE_SIZE;
  const pageEnd = pageStart + PROGRAM_PAGE_SIZE;
  const segments: { group: ProgramGroup; rows: ProgramRow[]; continued: boolean }[] = [];
  let cursor = 0;
  for (const group of groups) {
    const start = cursor;
    const end = start + group.rows.length;
    cursor = end;
    if (group.rows.length === 0) {
      const attachIndex = Math.min(start, Math.max(totalRows - 1, 0));
      if (Math.floor(attachIndex / PROGRAM_PAGE_SIZE) + 1 === currentPage) {
        segments.push({ group, rows: [], continued: false });
      }
      continue;
    }
    const from = Math.max(start, pageStart);
    const to = Math.min(end, pageEnd);
    if (from < to) {
      segments.push({ group, rows: group.rows.slice(from - start, to - start), continued: start < pageStart });
    }
  }

  function goToPage(next: number) {
    setPage(Math.max(1, Math.min(next, totalPages)));
    groupsTopRef.current?.scrollIntoView?.({ block: 'start' });
  }

  return (
    <PageShell>
      <PageHeader
        title={t('curriculumTreeTitle', { subject: tree.subject.name, grade: tree.curriculum.grade })}
        description={t('curriculumTreeDescription')}
      />
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="button" render={<Link to={`/admin/curriculum/curricula/${tree.curriculum.id}/nodes/new`} />}>
          {t('curriculumAddRootNode')}
        </Button>{' '}
        <Link to="/admin/curriculum" className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </div>
      <div className="flex flex-col gap-4" ref={groupsTopRef}>
        {segments.map(({ group, rows, continued }) => (
          <ProgramGroupTable
            key={`${group.key}-${continued ? 'cont' : 'start'}`}
            title={group.title}
            groupNode={group.groupNode}
            rows={rows}
            curriculumId={tree.curriculum.id}
            onDeleteNode={(n) => void deleteNode(n)}
            onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
            continued={continued}
          />
        ))}
      </div>
      {totalPages > 1 ? (
        <nav aria-label={t('curriculumPaginationLabel')} className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>
            {t('curriculumPagePrevious')}
          </Button>
          {pageNumberItems(totalPages, currentPage).map((item, i) =>
            item === 'gap' ? (
              <span key={`gap-${i}`} className="text-sm text-muted-foreground">…</span>
            ) : (
              <Button
                key={item}
                type="button"
                variant={item === currentPage ? 'default' : 'outline'}
                size="sm"
                aria-current={item === currentPage ? 'page' : undefined}
                onClick={() => goToPage(item)}
              >
                {item}
              </Button>
            ),
          )}
          <Button type="button" variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => goToPage(currentPage + 1)}>
            {t('curriculumPageNext')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('curriculumPageStatus', { current: currentPage, total: totalPages })}
          </span>
        </nav>
      ) : null}
    </PageShell>
  );
}
