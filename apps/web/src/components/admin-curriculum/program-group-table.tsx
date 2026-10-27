import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import type { CurriculumTreeNode } from '#lib/curriculum';

/**
 * Trình bày cây chương trình theo MẪU CỦA BỘ (GDPT-SEED, issue #161):
 * mỗi mạch nội dung (node strand ở gốc cây) là một bảng hai cột
 * "Nội dung | Yêu cầu cần đạt". Các bậc ở giữa (section/topic) không
 * thành dòng riêng nếu không mang YCCĐ — tựa của chúng flatten vào
 * đường đi ở cột Nội dung; node mang YCCĐ ở bất kỳ bậc nào cũng thành
 * dòng. Hành vi quản trị giữ nguyên §9: thêm node con / thêm YCCĐ /
 * Sửa mở màn riêng, Xoá tại dòng.
 *
 * Chế độ `readOnly` (trang xem chương trình của GIÁO VIÊN, issue #161
 * lát T2): cùng một cách trình bày mẫu Bộ nhưng KHÔNG nút thao tác —
 * giáo viên chỉ xem, sửa chương trình thuộc khu quản trị.
 *
 * Nội dung YCCĐ được trình bày GIỮ CẤU TRÚC DÒNG (điểm T3 của issue
 * #161): text canonical của một YCCĐ có thể gồm nhiều dòng (các ý đã
 * tách ở dataset, gồm danh sách ý cha–con) — mỗi dòng render thành
 * một khối riêng thay vì một đoạn chạy liền mất phân cấp dòng.
 * Từ khi cột lưu trữ chuyển sang tài liệu Tiptap (jsonb), YCCĐ có ý
 * con được render PHÂN CẤP CHA–CON nhìn thấy được: ý cha là một khối,
 * ý con thụt lề dưới ý cha với dấu gạch đầu dòng, danh sách lồng
 * sâu hơn thụt lề thêm một mức — đúng cấu trúc tài liệu, áp dụng
 * nhất quán cho cả bề mặt quản trị lẫn bề mặt giáo viên (cùng dùng
 * component này, chế độ chỉ đọc chỉ ẩn nút thao tác).
 */
export interface ProgramRow {
  node: CurriculumTreeNode;
  path: string[];
}

/** Flatten một subtree thành các dòng bảng (cha trước con, giữ thứ tự cây). */
export function flattenProgramRows(node: CurriculumTreeNode, path: string[], out: ProgramRow[]): void {
  if (node.kind === 'lesson' || node.outcomes.length > 0) out.push({ node, path });
  for (const child of node.children) flattenProgramRows(child, [...path, node.title], out);
}

/** Các nút thao tác tại dòng của một node (dùng cho cả tiêu đề mạch lẫn dòng nội dung). */
export function NodeRowActions({
  node, curriculumId, onDeleteNode,
}: {
  node: CurriculumTreeNode;
  curriculumId: string;
  onDeleteNode: (node: CurriculumTreeNode) => void;
}) {
  const { t } = useTranslation('app');
  return (
    <span className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/curricula/${curriculumId}/nodes/new?parentId=${node.id}`} />}>
        {t('curriculumAddChildNode')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/outcomes/new`} />}>
        {t('curriculumAddOutcome')}
      </Button>
      <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/nodes/${node.id}/edit`} />}>
        {t('curriculumEdit')}
      </Button>
      <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteNode(node)}>
        {t('curriculumDelete')}
      </Button>
    </span>
  );
}

/**
 * Nội dung một YCCĐ giữ cấu trúc dòng: YCCĐ một dòng render nguyên như
 * cũ; YCCĐ nhiều dòng thì mỗi dòng là một khối riêng trong cùng ô
 * (thứ tự dòng giữ nguyên thứ tự canonical của dataset).
 *
 * Khi có tài liệu Tiptap (`contentDoc`), render theo đúng cấu trúc
 * tài liệu thay vì phẳng hoá theo dòng text: đoạn văn thành một
 * khối; mục danh sách thành một khối thụt lề kèm dấu gạch đầu dòng,
 * và danh sách lồng bên trong mục đó thụt lề thêm một mức (đệ quy).
 * Nhờ đó quan hệ cha–con nhìn thấy được ngay trong ô, không cần
 * đọc text để đoán. Không có tài liệu (dữ liệu cũ hoặc bề mặt chưa
 * trả trường này) thì giữ đúng hành vi cũ: tách text theo dòng.
 */
export function OutcomeContent({
  content,
  contentDoc,
}: {
  content: string;
  contentDoc?: import('#lib/curriculum').CurriculumOutcomeDoc;
}) {
  if (contentDoc?.content) {
    return (
      <span>
        {contentDoc.content.map((node, index) => (
          <OutcomeDocNode key={index} node={node} />
        ))}
      </span>
    );
  }
  if (!content.includes('\n')) return <span>{content}</span>;
  return (
    <span>
      {content.split('\n').map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * Một node trong tài liệu Tiptap của một YCCĐ, render theo độ sâu
 * lồng của nó: đoạn văn là một khối text; mục danh sách là một khối
 * thụt lề (`pl-4`) kèm dấu gạch đầu dòng nằm cùng dòng với đoạn văn
 * của chính mục, danh sách lồng bên trong mục thụt lề thêm một mức.
 * Node lạ không thuộc các dạng này được bỏ qua thay vì làm vỡ cả
 * ô — text canonical ở `content` vẫn là nguồn đối chiếu đầy đủ.
 */
function OutcomeDocNode({
  node,
}: {
  node: import('#lib/curriculum').CurriculumOutcomeDocNode;
}) {
  if (node.type === 'paragraph') {
    const text = (node.content ?? [])
      .filter((child) => child.type === 'text')
      .map((child) => child.text ?? '')
      .join('');
    return <span className="block">{text}</span>;
  }
  if (node.type === 'listItem') {
    // Dấu gạch đầu dòng nằm cùng dòng với đoạn văn của chính mục
    // này; danh sách lồng bên trong (nếu có) render thành các khối
    // riêng thụt lề thêm một mức dưới nó.
    const children = node.content ?? [];
    const ownText = children
      .filter((child) => child.type === 'paragraph')
      .map((child) =>
        (child.content ?? [])
          .filter((grandchild) => grandchild.type === 'text')
          .map((grandchild) => grandchild.text ?? '')
          .join(''),
      )
      .join('');
    const nested = children.filter((child) => child.type !== 'paragraph');
    return (
      <span className="block pl-4">
        <span aria-hidden="true" className="text-muted-foreground">• </span>
        <span>{ownText}</span>
        {nested.map((child, index) => (
          <OutcomeDocNode key={index} node={child} />
        ))}
      </span>
    );
  }
  if (node.type === 'bulletList') {
    return (
      <span className="block">
        {(node.content ?? []).map((child, index) => (
          <OutcomeDocNode key={index} node={child} />
        ))}
      </span>
    );
  }
  return null;
}

/** Một bảng chương trình: tiêu đề mạch (nếu có) + các dòng Nội dung | Yêu cầu cần đạt. */
export function ProgramGroupTable({
  title, groupNode, rows, curriculumId, onDeleteNode, onDeleteOutcome, continued = false, readOnly = false,
}: {
  title: string | null;
  groupNode: CurriculumTreeNode | null;
  rows: ProgramRow[];
  curriculumId: string;
  onDeleteNode?: (node: CurriculumTreeNode) => void;
  onDeleteOutcome?: (node: CurriculumTreeNode, outcomeId: string) => void;
  /** Mạch này đã bắt đầu ở trang trước (phân trang cắt qua mạch) → tiêu đề kèm dấu (tiếp) như văn bản in. */
  continued?: boolean;
  /** Chỉ xem (trang giáo viên): ẩn mọi nút thao tác tại dòng và tại tiêu đề mạch. */
  readOnly?: boolean;
}) {
  const { t } = useTranslation('app');
  return (
    <section className="overflow-hidden rounded border">
      {title !== null && groupNode ? (
        <header className="flex flex-wrap items-center gap-2 border-b bg-muted/40 p-3">
          <Badge variant="default">{t(`curriculumKind_${groupNode.kind}`)}</Badge>
          <h3 className="font-semibold">{title}</h3>
          {continued ? <span className="text-sm text-muted-foreground">{t('curriculumGroupContinued')}</span> : null}
          {!readOnly && onDeleteNode ? (
            <span className="ml-auto">
              <NodeRowActions node={groupNode} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
            </span>
          ) : null}
        </header>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="w-1/2 p-2 font-medium">{t('curriculumContentColumn')}</th>
            <th className="p-2 font-medium">{t('curriculumOutcomesLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ node, path }) => (
            <tr key={node.id} className="border-b align-top last:border-0">
              <td className="p-2">
                {path.length > 0 ? (
                  <span className="block text-xs text-muted-foreground">{path.join(' › ')}</span>
                ) : null}
                <span className="font-medium">{node.title}</span>
                {!readOnly && onDeleteNode ? (
                  <span className="mt-1 block">
                    <NodeRowActions node={node} curriculumId={curriculumId} onDeleteNode={onDeleteNode} />
                  </span>
                ) : null}
              </td>
              <td className="p-2">
                {node.outcomes.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {node.outcomes.map((outcome) => (
                      <li key={outcome.id} className="flex flex-wrap items-start gap-2">
                        <span aria-hidden="true" className="text-muted-foreground">–</span>
                        <span className="min-w-0 flex-1">
                          <OutcomeContent content={outcome.content} contentDoc={outcome.contentDoc} />
                          {outcome.sourceRef ? (
                            <span className="block text-xs text-muted-foreground">
                              {t('curriculumOutcomeSource', { source: outcome.sourceRef })}
                            </span>
                          ) : null}
                        </span>
                        {!readOnly && onDeleteOutcome ? (
                          <span className="flex gap-2">
                            <Button type="button" variant="outline" size="sm" render={<Link to={`/admin/curriculum/outcomes/${outcome.id}/edit`} />}>
                              {t('curriculumEdit')}
                            </Button>
                            <Button type="button" variant="destructive" size="sm" onClick={() => onDeleteOutcome(node, outcome.id)}>
                              {t('curriculumDelete')}
                            </Button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
