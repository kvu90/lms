import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@lms/ui/components/button';
import { Label } from '@lms/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@lms/ui/components/select';
import { ErrorAlert } from '#components/error-alert';
import { PageHeader, PageShell } from '#components/page-shell';
import { ApiError } from '#lib/api';
import { useAccessContexts } from '#lib/access';
import { queryClient } from '#lib/query-client';
import {
  curriculumTreeScopedQueryOptions,
  useCurriculumCurriculaScoped, useCurriculumSubjectsScoped, useCurriculumTreeScoped,
  useDeleteCurriculumNode, useDeleteCurriculumOutcome,
  type CurriculumTree, type CurriculumTreeNode,
} from '#lib/curriculum';
import { flattenProgramRows, type ProgramRow } from './program-group-table';
import { buildProgramOutcomeRows, ProgramDataTable } from './program-data-table';
import { errorText } from '../utils/shared';

/**
 * Số dòng Nội dung trên một trang đọc cây chương trình. Văn bản in của
 * Bộ trình bày bảng Nội dung | Yêu cầu cần đạt liên tục và ngắt trang
 * theo khổ giấy (mỗi trang in chứa chừng chục dòng nội dung); bản số
 * hoá giữ đúng nhịp đọc đó: 10 dòng/trang, mạch bị cắt qua trang thì
 * lặp lại tiêu đề kèm dấu (tiếp). Phân trang chạy hoàn toàn phía
 * client — cây đã tải một lần, chuyển trang không gọi lại server.
 *
 * Hằng này hiện chỉ còn trang xem của giáo viên dùng (trang cây quản
 * trị đã chuyển sang phân trang của Data Table dùng chung); giữ
 * nguyên giá trị để nhịp đọc của bề mặt giáo viên không đổi.
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

/**
 * Trang cây chương trình của khu quản trị: bảng chương trình của một
 * môn ở một khối lớp, dựng trên Data Table dùng chung (mỗi YCCĐ một
 * dòng — xem `program-data-table.tsx`). Đầu trang có bộ chọn Môn và
 * bộ chọn Lớp để chuyển thẳng tới cây của môn/khối khác mà không
 * phải quay về trang danh sách; ô tìm kiếm là ô lọc toàn bảng của
 * Data Table.
 *
 * Luồng dữ liệu: cây đọc qua TanStack Query như trước (lỗi 403 thì
 * hiện thông báo không có quyền; chưa có dữ liệu thì giữ trạng thái
 * đang tải). Hai bộ chọn đọc thêm danh sách môn neo ở context hệ
 * thống và danh sách chương trình của môn đang chọn ở bộ chọn qua
 * cùng tầng `lib/curriculum`; các nguồn phụ này lỗi hoặc chưa về thì
 * bộ chọn tương ứng chưa hiện, bảng chính không bị ảnh hưởng. Đổi
 * Lớp thì điều hướng ngay tới cây của chương trình được chọn; đổi
 * Môn thì chờ danh sách chương trình của môn mới về rồi điều hướng
 * tới chương trình cùng khối nếu có, không thì khối nhỏ nhất của
 * môn đó. Xoá node/YCCĐ đi qua đột biến — cây tự làm mới nhờ
 * làm-mới-khoá của đột biến.
 */
export function AdminCurriculumTreePage() {
  const { t } = useTranslation('app');
  const { curriculumId } = useParams();
  const navigate = useNavigate();
  const [message, setMessage] = useState<string | null>(null);

  // Cây đọc qua TanStack Query (F-01 của rà soát #133): lỗi 403 thì
  // trang hiện thông báo không có quyền; chưa có dữ liệu thì giữ
  // trạng thái đang tải như bản thủ công. Xoá node/YCCĐ đi qua đột
  // biến — cây tự làm mới nhờ làm-mới-khoá của đột biến.
  const treeQuery = useCurriculumTreeScoped(curriculumId ?? '', undefined, curriculumId !== undefined);
  const tree = treeQuery.data ?? null;
  const forbidden = treeQuery.error instanceof ApiError && treeQuery.error.problem.status === 403;
  const deleteNodeMutation = useDeleteCurriculumNode();
  const deleteOutcomeMutation = useDeleteCurriculumOutcome();

  // Nguồn phụ cho hai bộ chọn Môn/Lớp: môn neo ở context hệ thống
  // (đọc qua tầng contexts như trang danh sách), chương trình theo
  // môn đang chọn ở bộ chọn. `pickedSubjectId` là môn người dùng vừa
  // chọn khi khác môn của cây đang xem; chưa chọn thì bộ chọn neo
  // theo môn của cây.
  const contextsQuery = useAccessContexts();
  const systemContextId = contextsQuery.data?.find((c) => c.contextLevel === 10)?.id ?? null;
  const subjectsQuery = useCurriculumSubjectsScoped(systemContextId);
  const subjects = useMemo(
    () => [...(subjectsQuery.data ?? [])].sort((a, b) => a.position - b.position),
    [subjectsQuery.data],
  );
  const [pickedSubjectId, setPickedSubjectId] = useState<string | null>(null);
  const selectorSubjectId = pickedSubjectId ?? tree?.subject.id ?? '';
  const curriculaQuery = useCurriculumCurriculaScoped(selectorSubjectId, undefined, selectorSubjectId !== '');
  const selectorCurricula = useMemo(
    () => [...(curriculaQuery.data ?? [])].sort((a, b) => a.grade - b.grade),
    [curriculaQuery.data],
  );

  // Đổi môn: danh sách chương trình của môn mới về thì điều hướng
  // tới chương trình cùng khối với cây đang xem nếu môn mới có khối
  // đó, không thì tới khối nhỏ nhất. Môn mới không có chương trình
  // nào thì giữ nguyên trang (không có đích để chuyển).
  useEffect(() => {
    if (!tree || !pickedSubjectId || pickedSubjectId === tree.subject.id) return;
    if (curriculaQuery.data === undefined) return;
    const target =
      selectorCurricula.find((c) => c.grade === tree.curriculum.grade) ?? selectorCurricula[0];
    if (target) navigate(`/admin/curriculum/curricula/${target.id}`);
  }, [pickedSubjectId, curriculaQuery.data, selectorCurricula, tree, navigate]);

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
        <ErrorAlert variant="destructive">
          {t('curriculumForbidden')}
        </ErrorAlert>
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

  const rows = buildProgramOutcomeRows(tree);
  // Giá trị bộ chọn Lớp khi bộ chọn đang neo ở môn khác với cây đang
  // xem (đang chờ điều hướng sau khi đổi môn): chương trình cùng
  // khối nếu có, không thì khối nhỏ nhất của môn đó.
  const gradeSelectValue =
    selectorSubjectId === tree.subject.id
      ? tree.curriculum.id
      : (selectorCurricula.find((c) => c.grade === tree.curriculum.grade)?.id ??
        selectorCurricula[0]?.id ??
        '');

  return (
    <PageShell>
      <PageHeader
        title={t('curriculumTreeTitle', { subject: tree.subject.name, grade: tree.curriculum.grade })}
        description={t('curriculumTreeDescription')}
      />
      {message ? (
        <ErrorAlert>
          {message}
        </ErrorAlert>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        {subjects.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="curriculum-tree-subject">{t('curriculumSubjectPickerLabel')}</Label>
            <Select
              value={selectorSubjectId}
              onValueChange={(value) => {
                if (value) setPickedSubjectId(value);
              }}
            >
              <SelectTrigger id="curriculum-tree-subject" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {subjects.map((subject) => (
                  <SelectItem key={subject.id} value={subject.id}>
                    {subject.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        {selectorCurricula.length > 0 ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="curriculum-tree-grade">{t('curriculumGradePickerLabel')}</Label>
            <Select
              value={gradeSelectValue}
              onValueChange={(value) => {
                if (value && value !== curriculumId) {
                  navigate(`/admin/curriculum/curricula/${value}`);
                }
              }}
            >
              <SelectTrigger id="curriculum-tree-grade" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {selectorCurricula.map((curriculum) => (
                  <SelectItem key={curriculum.id} value={curriculum.id}>
                    {t('curriculumGradeLabel', { grade: curriculum.grade })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      <div>
        <Button type="button" render={<Link to={`/admin/curriculum/curricula/${tree.curriculum.id}/nodes/new`} />}>
          {t('curriculumAddRootNode')}
        </Button>{' '}
        <Link to="/admin/curriculum" className="text-sm underline">
          {t('curriculumBackToList')}
        </Link>
      </div>
      <ProgramDataTable
        rows={rows}
        curriculumId={tree.curriculum.id}
        onDeleteNode={(n) => void deleteNode(n)}
        onDeleteOutcome={(n, id) => void deleteOutcome(n, id)}
      />
    </PageShell>
  );
}
