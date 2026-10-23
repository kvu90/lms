import { useState } from 'react';
import { Button } from '@lms/ui/components/button';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';

/**
 * Trình sửa cây điều kiện availability cho section/course module.
 *
 * Cây giữ đúng hình dạng JSON phía API (khớp `availability-tree` ở tầng
 * availability của backend, gốc Moodle core_availability): nút là
 * `{ op: '&' | '|' | '!&' | '!|', c: [...], show?, showc? }`, lá là
 * `{ type, ...tham số }` với sáu loại lá mà backend có evaluator:
 * - `date`: `{ d: '>=' | '<', t: epoch giây }`
 * - `grade`: `{ id: gradeItemId, min?, max? }` (min/max là phần trăm)
 * - `completion`: `{ id: cmId, state }` (1 hoàn thành, 2 đạt, 3 không đạt)
 * - `group`: `{ id: groupId }`, `grouping`: `{ id: groupingId }`
 * - `profile`: `{ field, operator: eq|contains|notempty|isempty, value? }`
 *
 * Lá thuộc loại lạ (plugin ngoài sáu loại trên) được giữ nguyên vẹn khi
 * lưu và chỉ cho xoá — trình sửa không đoán cấu trúc của chúng. Component
 * khởi tạo mô hình từ `value` tại thời điểm mount; nơi dùng phải truyền
 * `key` riêng cho từng section/module để đổi mục tiêu là dựng lại state.
 */

/** Toán tử của một nút cây availability. */
export type AvailabilityOp = '&' | '|' | '!&' | '!|';

/** Điều kiện lá: `type` quyết định các tham số còn lại. */
export interface AvailabilityLeafModel {
  type: string;
  [key: string]: unknown;
}

/** Nút cây availability: toán tử, điều kiện con, cờ hiện thông tin ở gốc (`show`) và theo từng con (`showc`). */
export interface AvailabilityNodeModel {
  op: AvailabilityOp;
  c: AvailabilityChildModel[];
  show?: boolean;
  showc?: boolean[];
}

export type AvailabilityChildModel = AvailabilityNodeModel | AvailabilityLeafModel;

/** Một lựa chọn id + nhãn cho các ô chọn (nhóm, grouping, module, mục điểm). */
export interface AvailabilityOption {
  id: string;
  name: string;
}

const OPS: AvailabilityOp[] = ['&', '|', '!&', '!|'];
const LEAF_TYPES = ['date', 'grade', 'completion', 'group', 'grouping', 'profile'] as const;
const STANDARD_PROFILE_FIELDS = ['username', 'firstName', 'lastName', 'email'] as const;

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs';

/** Phân biệt nút cây (có op + mảng c) với điều kiện lá. */
export function isAvailabilityNode(child: AvailabilityChildModel): child is AvailabilityNodeModel {
  const node = child as AvailabilityNodeModel;
  return typeof node.op === 'string' && Array.isArray(node.c);
}

/** Chuẩn hoá một lá đã biết về đúng khoá chính tắc mà backend đọc (d/t cho date, id cho completion/group/grouping, field/operator/value cho profile); lá lạ giữ nguyên. */
function normalizeLeaf(raw: Record<string, unknown>): AvailabilityLeafModel {
  switch (raw.type) {
    case 'date': {
      const rawTime = raw.t ?? raw.time;
      let t = 0;
      if (typeof rawTime === 'number') t = rawTime >= 1e12 ? Math.floor(rawTime / 1000) : rawTime;
      else if (typeof rawTime === 'string') t = Math.floor(Date.parse(rawTime) / 1000) || 0;
      return { type: 'date', d: String(raw.d ?? raw.direction ?? '>='), t };
    }
    case 'grade': {
      const leaf: AvailabilityLeafModel = { type: 'grade', id: String(raw.id ?? '') };
      if (raw.min !== undefined) leaf.min = Number(raw.min);
      if (raw.max !== undefined) leaf.max = Number(raw.max);
      return leaf;
    }
    case 'completion':
      return { type: 'completion', id: String(raw.id ?? raw.cmid ?? raw.cm ?? ''), state: Number(raw.state ?? 1) };
    case 'group':
      return { type: 'group', id: String(raw.id ?? raw.groupId ?? '') };
    case 'grouping':
      return { type: 'grouping', id: String(raw.id ?? raw.groupingId ?? '') };
    case 'profile': {
      const leaf: AvailabilityLeafModel = {
        type: 'profile',
        field: String(raw.field ?? raw.sf ?? ''),
        operator: String(raw.operator ?? raw.op ?? 'eq'),
      };
      const value = raw.value ?? raw.v;
      if (value !== undefined) leaf.value = String(value);
      return leaf;
    }
    default:
      return { ...(raw as AvailabilityLeafModel) };
  }
}

/** Chuẩn hoá đệ quy một nút cây thô từ API; op lạ rơi về '&', lá con giữ thứ tự và cờ showc/show như bản gốc. */
function normalizeNode(raw: Record<string, unknown>): AvailabilityNodeModel {
  const children = Array.isArray(raw.c) ? raw.c : [];
  const node: AvailabilityNodeModel = {
    op: OPS.includes(raw.op as AvailabilityOp) ? (raw.op as AvailabilityOp) : '&',
    c: children.map((child) => {
      const record = (child ?? {}) as Record<string, unknown>;
      return isAvailabilityNode(record as AvailabilityChildModel) ? normalizeNode(record) : normalizeLeaf(record);
    }),
  };
  if (typeof raw.show === 'boolean') node.show = raw.show;
  if (Array.isArray(raw.showc)) node.showc = raw.showc.map((v) => v !== false);
  return node;
}

/**
 * Đưa cây availability thô từ API (hoặc null) về mô hình sửa được; trả
 * null khi đầu vào trống hoặc không phải một nút cây hợp lệ.
 */
export function availabilityToModel(raw: unknown): AvailabilityNodeModel | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.c)) return null;
  return normalizeNode(record);
}

/**
 * Đưa mô hình về payload gửi API: cây gốc không còn điều kiện con nào thì
 * coi như không hạn chế (null), khớp cách backend lưu `availability`.
 */
export function availabilityToPayload(model: AvailabilityNodeModel | null): unknown {
  if (!model || model.c.length === 0) return null;
  return model;
}

/** Thay danh sách con của một nút, đồng thời căn lại mảng `showc` cho khớp số con (mặc định hiện lý do). */
function withChildren(node: AvailabilityNodeModel, children: AvailabilityChildModel[]): AvailabilityNodeModel {
  const showc = children.map((_, i) => node.showc?.[i] ?? true);
  return { ...node, c: children, showc };
}

/** Áp một hàm biến đổi lên nút tại đường dẫn (dãy chỉ số con từ gốc) và trả cây mới — không đột biến cây cũ. */
function updateAtPath(
  node: AvailabilityNodeModel,
  path: number[],
  fn: (n: AvailabilityNodeModel) => AvailabilityNodeModel,
): AvailabilityNodeModel {
  if (path.length === 0) return fn(node);
  const [head, ...rest] = path as [number, ...number[]];
  const children = node.c.map((child, i) => {
    if (i !== head || !isAvailabilityNode(child)) return child;
    return updateAtPath(child, rest, fn);
  });
  return { ...node, c: children };
}

/** Định dạng epoch giây thành giá trị cho ô `datetime-local` theo giờ địa phương của trình duyệt. */
function secondsToLocalInput(seconds: number): string {
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Các danh sách lựa chọn mà trình sửa cần từ trang chứa (theo đúng khoá học đang sửa). */
export interface AvailabilityEditorContext {
  groups: AvailabilityOption[];
  groupings: AvailabilityOption[];
  modules: AvailabilityOption[];
  gradeItems: AvailabilityOption[];
}

interface LeafEditorProps {
  leaf: AvailabilityLeafModel;
  idPrefix: string;
  ctx: AvailabilityEditorContext;
  onChange: (next: AvailabilityLeafModel) => void;
}

/** Form sửa tham số của một điều kiện lá theo đúng loại; lá lạ chỉ hiện thông báo giữ nguyên. */
function LeafEditor({ leaf, idPrefix, ctx, onChange }: LeafEditorProps) {
  const { t } = useTranslation('app');
  switch (leaf.type) {
    case 'date': {
      const direction = String(leaf.d ?? '>=');
      const seconds = typeof leaf.t === 'number' ? leaf.t : 0;
      return (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-direction`}>{t('availabilityDateDirection')}</Label>
            <select
              id={`${idPrefix}-direction`}
              className={SELECT_CLASS}
              value={direction}
              onChange={(e) => onChange({ ...leaf, d: e.target.value })}
            >
              <option value=">=">{t('availabilityDateFrom')}</option>
              <option value="<">{t('availabilityDateUntil')}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-time`}>{t('availabilityDateValue')}</Label>
            <Input
              id={`${idPrefix}-time`}
              type="datetime-local"
              value={secondsToLocalInput(seconds)}
              onChange={(e) => {
                const ms = Date.parse(e.target.value);
                if (!Number.isNaN(ms)) onChange({ ...leaf, t: Math.floor(ms / 1000) });
              }}
            />
          </div>
        </div>
      );
    }
    case 'grade': {
      const min = leaf.min === undefined ? '' : String(leaf.min);
      const max = leaf.max === undefined ? '' : String(leaf.max);
      return (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-grade-item`}>{t('availabilityGradeItem')}</Label>
            {ctx.gradeItems.length > 0 ? (
              <select
                id={`${idPrefix}-grade-item`}
                className={SELECT_CLASS}
                value={String(leaf.id ?? '')}
                onChange={(e) => onChange({ ...leaf, id: e.target.value })}
              >
                {ctx.gradeItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={`${idPrefix}-grade-item`}
                value={String(leaf.id ?? '')}
                onChange={(e) => onChange({ ...leaf, id: e.target.value })}
              />
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-grade-min`}>{t('availabilityGradeMin')}</Label>
            <Input
              id={`${idPrefix}-grade-min`}
              type="number"
              min={0}
              max={100}
              value={min}
              onChange={(e) => {
                const next = { ...leaf };
                if (e.target.value === '') delete next.min;
                else next.min = Number(e.target.value);
                onChange(next);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-grade-max`}>{t('availabilityGradeMax')}</Label>
            <Input
              id={`${idPrefix}-grade-max`}
              type="number"
              min={0}
              max={100}
              value={max}
              onChange={(e) => {
                const next = { ...leaf };
                if (e.target.value === '') delete next.max;
                else next.max = Number(e.target.value);
                onChange(next);
              }}
            />
          </div>
        </div>
      );
    }
    case 'completion': {
      return (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-completion-cm`}>{t('availabilityCompletionActivity')}</Label>
            <select
              id={`${idPrefix}-completion-cm`}
              className={SELECT_CLASS}
              value={String(leaf.id ?? '')}
              onChange={(e) => onChange({ ...leaf, id: e.target.value })}
            >
              {ctx.modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-completion-state`}>{t('availabilityCompletionState')}</Label>
            <select
              id={`${idPrefix}-completion-state`}
              className={SELECT_CLASS}
              value={String(leaf.state ?? 1)}
              onChange={(e) => onChange({ ...leaf, state: Number(e.target.value) })}
            >
              <option value="1">{t('availabilityCompletionComplete')}</option>
              <option value="2">{t('availabilityCompletionPass')}</option>
              <option value="3">{t('availabilityCompletionFail')}</option>
            </select>
          </div>
        </div>
      );
    }
    case 'group':
    case 'grouping': {
      const options = leaf.type === 'group' ? ctx.groups : ctx.groupings;
      const label = leaf.type === 'group' ? t('availabilityGroupSelect') : t('availabilityGroupingSelect');
      return (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-membership`}>{label}</Label>
          <select
            id={`${idPrefix}-membership`}
            className={SELECT_CLASS}
            value={String(leaf.id ?? '')}
            onChange={(e) => onChange({ ...leaf, id: e.target.value })}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      );
    }
    case 'profile': {
      const field = String(leaf.field ?? '');
      const isStandard = (STANDARD_PROFILE_FIELDS as readonly string[]).includes(field);
      const operator = String(leaf.operator ?? 'eq');
      const needsValue = operator !== 'notempty' && operator !== 'isempty';
      return (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-profile-field`}>{t('availabilityProfileField')}</Label>
            <select
              id={`${idPrefix}-profile-field`}
              className={SELECT_CLASS}
              value={isStandard ? field : '__custom'}
              onChange={(e) => onChange({ ...leaf, field: e.target.value === '__custom' ? '' : e.target.value })}
            >
              <option value="username">{t('availabilityProfileUsername')}</option>
              <option value="firstName">{t('availabilityProfileFirstname')}</option>
              <option value="lastName">{t('availabilityProfileLastname')}</option>
              <option value="email">{t('availabilityProfileEmail')}</option>
              <option value="__custom">{t('availabilityProfileCustomOption')}</option>
            </select>
          </div>
          {!isStandard ? (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-profile-custom`}>{t('availabilityProfileFieldCustom')}</Label>
              <Input
                id={`${idPrefix}-profile-custom`}
                value={field}
                onChange={(e) => onChange({ ...leaf, field: e.target.value })}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-profile-operator`}>{t('availabilityProfileOperator')}</Label>
            <select
              id={`${idPrefix}-profile-operator`}
              className={SELECT_CLASS}
              value={operator}
              onChange={(e) => onChange({ ...leaf, operator: e.target.value })}
            >
              <option value="eq">{t('availabilityProfileOpEq')}</option>
              <option value="contains">{t('availabilityProfileOpContains')}</option>
              <option value="notempty">{t('availabilityProfileOpNotEmpty')}</option>
              <option value="isempty">{t('availabilityProfileOpIsEmpty')}</option>
            </select>
          </div>
          {needsValue ? (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-profile-value`}>{t('availabilityProfileValue')}</Label>
              <Input
                id={`${idPrefix}-profile-value`}
                value={String(leaf.value ?? '')}
                onChange={(e) => onChange({ ...leaf, value: e.target.value })}
              />
            </div>
          ) : null}
        </div>
      );
    }
    default:
      return <p className="text-sm text-muted-foreground">{t('availabilityLeafUnknown', { type: leaf.type })}</p>;
  }
}

interface NodeEditorProps {
  node: AvailabilityNodeModel;
  path: number[];
  isRoot: boolean;
  ctx: AvailabilityEditorContext;
  onUpdate: (path: number[], next: AvailabilityNodeModel) => void;
  onRemoveSelf: (() => void) | null;
}

/** Một nút cây đệ quy: chọn toán tử, cờ show/showc, danh sách con và các nút thêm điều kiện/nhóm con. */
function NodeEditor({ node, path, isRoot, ctx, onUpdate, onRemoveSelf }: NodeEditorProps) {
  const { t } = useTranslation('app');
  const [newLeafType, setNewLeafType] = useState<string>('date');
  const pathKey = path.length === 0 ? 'root' : path.join('-');

  const LEAF_LABELS: Record<string, string> = {
    date: t('availabilityLeafDate'),
    grade: t('availabilityLeafGrade'),
    completion: t('availabilityLeafCompletion'),
    group: t('availabilityLeafGroup'),
    grouping: t('availabilityLeafGrouping'),
    profile: t('availabilityLeafProfile'),
  };

  /** Lá mặc định cho từng loại, bám đúng tham số tối thiểu mà evaluator phía backend cần. */
  function defaultLeaf(type: string): AvailabilityLeafModel {
    switch (type) {
      case 'date':
        return { type, d: '>=', t: Math.floor(Date.now() / 1000) };
      case 'grade':
        return { type, id: ctx.gradeItems[0]?.id ?? '' };
      case 'completion':
        return { type, id: ctx.modules[0]?.id ?? '', state: 1 };
      case 'group':
        return { type, id: ctx.groups[0]?.id ?? '' };
      case 'grouping':
        return { type, id: ctx.groupings[0]?.id ?? '' };
      default:
        return { type: 'profile', field: 'email', operator: 'eq', value: '' };
    }
  }

  function replaceSelf(next: AvailabilityNodeModel) {
    onUpdate(path, next);
  }

  function updateChild(index: number, nextChild: AvailabilityChildModel) {
    replaceSelf({ ...node, c: node.c.map((child, i) => (i === index ? nextChild : child)) });
  }

  return (
    <div data-testid={`availability-node-${pathKey}`} className="space-y-3 rounded border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`avail-${pathKey}-op`}>{t('availabilityOperator')}</Label>
          <select
            id={`avail-${pathKey}-op`}
            data-testid={`avail-op-${pathKey}`}
            className={SELECT_CLASS}
            value={node.op}
            onChange={(e) => replaceSelf({ ...node, op: e.target.value as AvailabilityOp })}
          >
            <option value="&">{t('availabilityOpAnd')}</option>
            <option value="|">{t('availabilityOpOr')}</option>
            <option value="!&">{t('availabilityOpNotAnd')}</option>
            <option value="!|">{t('availabilityOpNotOr')}</option>
          </select>
        </div>
        {isRoot ? (
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={node.show ?? true}
              onChange={(e) => replaceSelf({ ...node, show: e.target.checked })}
            />
            {t('availabilityRootShow')}
          </label>
        ) : null}
        {onRemoveSelf ? (
          <Button type="button" variant="destructive" size="sm" onClick={onRemoveSelf}>
            {t('availabilityRemoveGroup')}
          </Button>
        ) : null}
      </div>

      {node.c.length === 0 ? <p className="text-sm text-muted-foreground">{t('availabilityEmpty')}</p> : null}
      <ul className="space-y-3">
        {node.c.map((child, index) => (
          <li key={index} className="space-y-2 rounded border border-dashed p-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                aria-label={t('availabilityShowChild')}
                checked={node.showc?.[index] ?? true}
                onChange={(e) => {
                  const showc = node.c.map((_, i) => (i === index ? e.target.checked : (node.showc?.[i] ?? true)));
                  replaceSelf({ ...node, showc });
                }}
              />
              {t('availabilityShowChild')}
            </label>
            {isAvailabilityNode(child) ? (
              <NodeEditor
                node={child}
                path={[...path, index]}
                isRoot={false}
                ctx={ctx}
                onUpdate={onUpdate}
                onRemoveSelf={() =>
                  replaceSelf(
                    withChildren(
                      node,
                      node.c.filter((_, i) => i !== index),
                    ),
                  )
                }
              />
            ) : (
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{LEAF_LABELS[child.type] ?? child.type}</p>
                  <LeafEditor
                    leaf={child}
                    idPrefix={`avail-${pathKey}-${index}`}
                    ctx={ctx}
                    onChange={(next) => updateChild(index, next)}
                  />
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  aria-label={t('availabilityRemoveCondition')}
                  onClick={() =>
                    replaceSelf(
                      withChildren(
                        node,
                        node.c.filter((_, i) => i !== index),
                      ),
                    )
                  }
                >
                  {t('availabilityRemoveCondition')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`avail-${pathKey}-new-type`}>{t('availabilityNewConditionType')}</Label>
          <select
            id={`avail-${pathKey}-new-type`}
            className={SELECT_CLASS}
            value={newLeafType}
            onChange={(e) => setNewLeafType(e.target.value)}
          >
            {LEAF_TYPES.map((type) => (
              <option key={type} value={type}>
                {LEAF_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => replaceSelf(withChildren(node, [...node.c, defaultLeaf(newLeafType)]))}
        >
          {t('availabilityAddCondition')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => replaceSelf(withChildren(node, [...node.c, { op: '&', c: [] }]))}
        >
          {t('availabilityAddGroup')}
        </Button>
      </div>
    </div>
  );
}

export interface AvailabilityEditorProps extends AvailabilityEditorContext {
  /** Cây availability thô hiện tại từ API (null = chưa có hạn chế). */
  value: unknown;
  /** Gọi mỗi lần cây thay đổi, với payload đúng hình dạng API (null khi cây rỗng). */
  onChange: (next: unknown) => void;
}

/**
 * Trình sửa cây availability hoàn chỉnh cho một section hoặc một course
 * module: giữ state mô hình nội bộ khởi tạo từ `value`, mọi thay đổi đều
 * phát ra qua `onChange` dưới dạng payload JSON khớp cây phía API.
 */
export function AvailabilityEditor({
  value,
  onChange,
  groups,
  groupings,
  modules,
  gradeItems,
}: AvailabilityEditorProps) {
  const [model, setModel] = useState<AvailabilityNodeModel>(() => availabilityToModel(value) ?? { op: '&', c: [] });
  const ctx: AvailabilityEditorContext = { groups, groupings, modules, gradeItems };

  function handleUpdate(path: number[], next: AvailabilityNodeModel) {
    // NodeEditor con gọi lên với đường dẫn tích luỹ từ gốc kèm nút mới của
    // chính nó — áp thay thế tại đúng đường dẫn đó lên mô hình gốc.
    const updated = updateAtPath(model, path, () => next);
    setModel(updated);
    onChange(availabilityToPayload(updated));
  }

  return <NodeEditor node={model} path={[]} isRoot ctx={ctx} onUpdate={handleUpdate} onRemoveSelf={null} />;
}
