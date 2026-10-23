import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@lms/ui/components/ui/badge';
import { Button } from '@lms/ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@lms/ui/components/ui/card';
import { Input } from '@lms/ui/components/ui/input';
import { Label } from '@lms/ui/components/ui/label';
import { useAuth } from '@/lib/auth';
import { usePermissions } from '@/lib/permissions';
import { useTranslation } from 'react-i18next';
import { DataTable, type DataColumn } from '@/components/data-table';
import '../i18n';
import { apiJson, ApiError } from '@/lib/api';

interface PlanView {
  id: string;
  name: string;
  status: number;
  templateid: string | null;
}
interface PlanDetail {
  plan: PlanView;
  competencies: {
    competency: { id: string; shortname: string };
    usercomp: { id: string; grade: number | null; proficiency: boolean | null; status: number } | null;
  }[];
  reviews: { action: string; timecreated: string }[];
}

/**
 * Framework như API trả về (bản ghi `competency_framework`): thang đánh giá
 * nằm trong `scaleconfiguration` dạng `{ values, proficient }` — cùng hình
 * dạng `competencyScaleSchema` mà DTO tạo framework nhận ở trường `scale`.
 */
interface FrameworkView {
  id: string;
  shortname: string;
  idnumber?: string;
  description?: string;
  scaleconfiguration?: { values?: string[]; proficient?: number[] } | null;
  visible?: boolean;
}
/** Competency như API trả về (bản ghi `competency`): cây qua `parentid`/`depth`/`path`. */
interface CompetencyView {
  id: string;
  shortname: string;
  idnumber?: string;
  description?: string;
  parentid?: string | null;
  depth?: number;
}
/** Template như API trả về (bản ghi `competency_template`). */
interface TemplateView {
  id: string;
  shortname: string;
  description?: string;
  duedate?: string | null;
}
/** User competency như API trả về (bản ghi `competency_usercomp`): `status` là trạng thái duyệt 0/1/2. */
interface UsercompView {
  id: string;
  userid: string;
  competencyid: string;
  status: number;
  grade: number | null;
  proficiency: boolean | null;
}
/** Người dùng trong danh sách chọn của hàng đợi duyệt (GET /users trả `{ users, total, ... }`). */
interface UserOption {
  id: string;
  username: string;
}

/** Nhãn trạng thái dịch qua catalog ở thời điểm render (xem hook trong component). */

/**
 * Khu quản lý competency + hàng đợi duyệt, chỉ render khi người dùng có
 * quyền quản trị (`canAdminister` từ `usePermissions()`).
 *
 * Đối chiếu DTO ở `packages/contracts/src/engagement.ts` (bản ở worktree
 * này) và controller/service ở `apps/api/src/modules/competencies`:
 * - Tạo framework: `createCompetencyFrameworkSchema` = `{ shortname,
 *   idnumber?, description?, scale: { values: string[], proficient:
 *   number[] }, visible? }` — form thu values/proficient dạng danh sách
 *   phân tách bằng dấu phẩy rồi đóng gói đúng hình dạng đó.
 * - Thêm competency: `createCompetencySchema` = `{ shortname, idnumber?,
 *   description?, parentId? }` vào `POST /frameworks/:id/competencies`.
 * - Tạo template: `createLearningPlanTemplateSchema` = `{ shortname,
 *   description?, duedate? }`; gắn competency/cohort lần lượt là
 *   `addTemplateCompetencySchema` = `{ competencyId }` và
 *   `addTemplateCohortSchema` = `{ cohortId }`; `create-plans` không có body.
 *
 * Quy tắc hiện nút duyệt lấy đúng từ `planTransition` và
 * `transitionUsercompReview` trong competencies.service:
 * - Plan (0 nháp, 1 đang thực hiện, 2 chờ duyệt, 3 đang duyệt, 4 hoàn
 *   thành): start-review chỉ từ 2; approve chỉ từ 3; unapprove chỉ từ 1;
 *   complete từ 1 hoặc 3.
 * - Usercomp (0 chưa duyệt, 1 chờ duyệt, 2 đang duyệt): start-review chỉ
 *   từ 1; approve/reject từ 1 hoặc 2, body lần lượt là
 *   `competencyReviewDecisionSchema` và `competencyNoteSchema` (mọi trường
 *   đều tuỳ chọn nên gửi `{}` khi không nhập grade/note).
 */
function CompetencyAdmin() {
  const { t } = useTranslation('app');
  const PLAN_STATUS: Record<number, string> = {
    0: t('planStatusDraft'),
    1: t('planStatusActive'),
    2: t('planStatusWaiting'),
    3: t('planStatusInReview'),
    4: t('planStatusComplete'),
  };
  const REVIEW_STATUS: Record<number, string> = {
    0: t('reviewStatusNone'),
    1: t('reviewStatusWaiting'),
    2: t('reviewStatusInReview'),
  };
  const [frameworks, setFrameworks] = useState<FrameworkView[]>([]);
  const [templates, setTemplates] = useState<TemplateView[]>([]);
  const [competencies, setCompetencies] = useState<CompetencyView[]>([]);
  const [selectedFrameworkId, setSelectedFrameworkId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [fwDraft, setFwDraft] = useState({
    shortname: '',
    idnumber: '',
    description: '',
    scaleValues: '',
    scaleProficient: '',
    visible: true,
  });
  const [compDraft, setCompDraft] = useState({ shortname: '', idnumber: '', description: '', parentId: '' });
  const [tplDraft, setTplDraft] = useState({ shortname: '', description: '', duedate: '' });
  const [tplCompetencyId, setTplCompetencyId] = useState('');
  const [tplCohortId, setTplCohortId] = useState('');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [reviewUserId, setReviewUserId] = useState('');
  const [reviewPlans, setReviewPlans] = useState<PlanView[] | null>(null);
  const [reviewUsercomps, setReviewUsercomps] = useState<UsercompView[] | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importInputKey, setImportInputKey] = useState(0);

  /** Nạp danh sách framework + template cho khu quản lý. */
  const reloadAdmin = useCallback(async () => {
    const [fws, tpls] = await Promise.all([
      apiJson<FrameworkView[]>('/api/v1/competencies/frameworks'),
      apiJson<TemplateView[]>('/api/v1/competencies/templates'),
    ]);
    setFrameworks(fws);
    setTemplates(tpls);
    setSelectedTemplateId((prev) => prev || (tpls[0]?.id ?? ''));
  }, []);

  /** Nạp cây competency của một framework. */
  const loadCompetencies = useCallback(async (frameworkId: string) => {
    if (!frameworkId) {
      setCompetencies([]);
      return;
    }
    setCompetencies(await apiJson<CompetencyView[]>(`/api/v1/competencies/frameworks/${frameworkId}/competencies`));
  }, []);

  useEffect(() => {
    void reloadAdmin().catch(() => setAdminError(t('compAdminLoadFailed')));
  }, [reloadAdmin, t]);

  /**
   * Thử nạp danh sách người dùng cho ô chọn của hàng đợi duyệt qua
   * GET /api/v1/users (hình dạng `{ users, total, page, pageSize }` của
   * `userListResponseSchema`); gọi không được thì để trống — quản trị vẫn
   * nhập tay userId vào ô nhập bên dưới.
   */
  useEffect(() => {
    void (async () => {
      try {
        const res = await apiJson<{ users?: UserOption[] } | UserOption[]>('/api/v1/users?page=1&pageSize=50');
        setUsers(Array.isArray(res) ? res : (res.users ?? []));
      } catch {
        setUsers([]);
      }
    })();
  }, []);

  /** Tạo framework qua POST /frameworks với đúng body của `createCompetencyFrameworkSchema`. */
  async function createFramework(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    const values = fwDraft.scaleValues
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const proficient = fwDraft.scaleProficient
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map(Number);
    try {
      await apiJson('/api/v1/competencies/frameworks', {
        method: 'POST',
        body: JSON.stringify({
          shortname: fwDraft.shortname,
          ...(fwDraft.idnumber.trim() ? { idnumber: fwDraft.idnumber.trim() } : {}),
          ...(fwDraft.description.trim() ? { description: fwDraft.description.trim() } : {}),
          scale: { values, proficient },
          visible: fwDraft.visible,
        }),
      });
      setFwDraft({ shortname: '', idnumber: '', description: '', scaleValues: '', scaleProficient: '', visible: true });
      setAdminMessage(t('compFrameworkCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('compFrameworkCreateFailed'));
    }
  }

  /**
   * Xuất framework ra file JSON: GET /frameworks/:id/export trả tài liệu
   * JSON của hệ thống (framework + cây competency + rule); trang đóng gói
   * thành Blob tải xuống ngay trên trình duyệt, không qua máy chủ tệp.
   */
  async function exportFramework(fw: FrameworkView) {
    setAdminMessage(null);
    try {
      const doc = await apiJson<unknown>(`/api/v1/competencies/frameworks/${fw.id}/export`);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `framework-${fw.shortname || fw.id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setAdminMessage(t('compExported', { name: fw.shortname }));
    } catch {
      setAdminMessage(t('compExportFailed'));
    }
  }

  /**
   * Nhập framework từ file JSON đã xuất: đọc file ngay trên trình duyệt,
   * phân tích JSON rồi POST /frameworks/import — backend kiểm chứng toàn
   * vẹn tài liệu bằng `frameworkExportSchema` và tạo framework MỚI (mọi id
   * đều mới). Lỗi toàn vẹn của API (Problem Details) được hiện nguyên văn
   * `detail` để quản trị sửa file, không nuốt thành thông báo chung chung.
   */
  async function importFramework(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    setImportError(null);
    if (!importFile) return;
    let doc: unknown;
    try {
      doc = JSON.parse(await importFile.text());
    } catch {
      setImportError(t('compImportInvalidJson'));
      return;
    }
    try {
      const created = await apiJson<FrameworkView>('/api/v1/competencies/frameworks/import', {
        method: 'POST',
        body: JSON.stringify(doc),
      });
      setImportFile(null);
      setImportInputKey((k) => k + 1);
      setAdminMessage(t('compImportSuccess', { name: created.shortname }));
      await reloadAdmin();
    } catch (err) {
      setImportError(
        err instanceof ApiError
          ? t('compImportApiError', { detail: err.problem.detail ?? err.problem.title })
          : t('compImportFailed'),
      );
    }
  }

  /** Thêm competency vào framework đang chọn qua POST /frameworks/:id/competencies (`createCompetencySchema`). */
  async function createCompetency(event: FormEvent) {
    event.preventDefault();
    if (!selectedFrameworkId) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/competencies/frameworks/${selectedFrameworkId}/competencies`, {
        method: 'POST',
        body: JSON.stringify({
          shortname: compDraft.shortname,
          ...(compDraft.idnumber.trim() ? { idnumber: compDraft.idnumber.trim() } : {}),
          ...(compDraft.description.trim() ? { description: compDraft.description.trim() } : {}),
          ...(compDraft.parentId ? { parentId: compDraft.parentId } : {}),
        }),
      });
      setCompDraft({ shortname: '', idnumber: '', description: '', parentId: '' });
      setAdminMessage(t('compCompetencyCreated'));
      await loadCompetencies(selectedFrameworkId);
    } catch {
      setAdminMessage(t('compCompetencyCreateFailed'));
    }
  }

  /** Tạo template qua POST /templates (`createLearningPlanTemplateSchema`). */
  async function createTemplate(event: FormEvent) {
    event.preventDefault();
    setAdminMessage(null);
    try {
      const created = await apiJson<TemplateView>('/api/v1/competencies/templates', {
        method: 'POST',
        body: JSON.stringify({
          shortname: tplDraft.shortname,
          ...(tplDraft.description.trim() ? { description: tplDraft.description.trim() } : {}),
          ...(tplDraft.duedate ? { duedate: tplDraft.duedate } : {}),
        }),
      });
      setTplDraft({ shortname: '', description: '', duedate: '' });
      setSelectedTemplateId(created.id);
      setAdminMessage(t('compTemplateCreated'));
      await reloadAdmin();
    } catch {
      setAdminMessage(t('compTemplateCreateFailed'));
    }
  }

  /** Gắn competency vào template đang chọn: POST /templates/:id/competencies với `{ competencyId }`. */
  async function addTemplateCompetency(event: FormEvent) {
    event.preventDefault();
    if (!selectedTemplateId) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/competencies/templates/${selectedTemplateId}/competencies`, {
        method: 'POST',
        body: JSON.stringify({ competencyId: tplCompetencyId.trim() }),
      });
      setTplCompetencyId('');
      setAdminMessage(t('compTemplateCompetencyAdded'));
    } catch {
      setAdminMessage(t('compActionFailed'));
    }
  }

  /** Gắn cohort vào template đang chọn: POST /templates/:id/cohorts với `{ cohortId }`. */
  async function addTemplateCohort(event: FormEvent) {
    event.preventDefault();
    if (!selectedTemplateId) return;
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/competencies/templates/${selectedTemplateId}/cohorts`, {
        method: 'POST',
        body: JSON.stringify({ cohortId: tplCohortId.trim() }),
      });
      setTplCohortId('');
      setAdminMessage(t('compTemplateCohortAdded'));
    } catch {
      setAdminMessage(t('compActionFailed'));
    }
  }

  /** Sinh plan cho mọi thành viên cohort đã gắn: POST /templates/:id/create-plans (không body). */
  async function createPlansFromTemplate() {
    if (!selectedTemplateId) return;
    setAdminMessage(null);
    try {
      const res = await apiJson<{ created: number }>(
        `/api/v1/competencies/templates/${selectedTemplateId}/create-plans`,
        { method: 'POST', body: '{}' },
      );
      setAdminMessage(t('compPlansCreated', { count: res.created }));
    } catch {
      setAdminMessage(t('compActionFailed'));
    }
  }

  /** Tải plans + usercomp của người dùng đang chọn trong hàng đợi duyệt. */
  const loadReviewQueue = useCallback(async (targetUserId: string) => {
    const uid = targetUserId.trim();
    if (!uid) return;
    const [plans, usercomps] = await Promise.all([
      apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${uid}`),
      apiJson<UsercompView[]>(`/api/v1/competencies/usercomp/user/${uid}`),
    ]);
    setReviewPlans(plans);
    setReviewUsercomps(usercomps);
  }, []);

  /** Thao tác duyệt trên một plan (start-review/approve/unapprove/complete), xong tải lại hàng đợi. */
  async function planReviewAction(planId: string, action: 'start-review' | 'approve' | 'unapprove' | 'complete') {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/competencies/plans/${planId}/${action}`, { method: 'POST', body: '{}' });
      setAdminMessage(t('compReviewActionDone'));
      await loadReviewQueue(reviewUserId);
    } catch {
      setAdminMessage(t('compReviewActionFailed'));
    }
  }

  /** Thao tác duyệt trên một usercomp (start-review/approve/reject), xong tải lại hàng đợi. */
  async function usercompReviewAction(usercompId: string, action: 'start-review' | 'approve' | 'reject') {
    setAdminMessage(null);
    try {
      await apiJson(`/api/v1/competencies/usercomp/${usercompId}/${action}`, { method: 'POST', body: '{}' });
      setAdminMessage(t('compReviewActionDone'));
      await loadReviewQueue(reviewUserId);
    } catch {
      setAdminMessage(t('compReviewActionFailed'));
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t('compAdminTitle')}</CardTitle>
          <CardDescription>{t('compAdminDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {adminError ? <p role="alert">{adminError}</p> : null}
          {adminMessage ? <p role="status">{adminMessage}</p> : null}
          <div className="space-y-3">
            <h3 className="font-medium">{t('compFrameworksTitle')}</h3>
            <ul className="space-y-1" aria-label={t('compFrameworksTitle')}>
              {frameworks.map((fw) => (
                <li key={fw.id} className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{fw.shortname}</span>
                  {fw.scaleconfiguration?.values?.length ? (
                    <span>{fw.scaleconfiguration.values.join(', ')}</span>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSelectedFrameworkId(fw.id);
                      void loadCompetencies(fw.id).catch(() => setAdminError(t('compAdminLoadFailed')));
                    }}
                  >
                    {t('compViewCompetencies')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void exportFramework(fw)}>
                    {t('compExportFramework')}
                  </Button>
                </li>
              ))}
              {frameworks.length === 0 ? <li className="text-sm">{t('compNoFrameworks')}</li> : null}
            </ul>
            <form onSubmit={(e) => void createFramework(e)} className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="fw-shortname">{t('compFrameworkShortname')}</Label>
                <Input
                  id="fw-shortname"
                  value={fwDraft.shortname}
                  onChange={(e) => setFwDraft({ ...fwDraft, shortname: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fw-idnumber">{t('compFrameworkIdnumber')}</Label>
                <Input
                  id="fw-idnumber"
                  value={fwDraft.idnumber}
                  onChange={(e) => setFwDraft({ ...fwDraft, idnumber: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fw-description">{t('compFrameworkDescription')}</Label>
                <Input
                  id="fw-description"
                  value={fwDraft.description}
                  onChange={(e) => setFwDraft({ ...fwDraft, description: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fw-scale-values">{t('compScaleValues')}</Label>
                <Input
                  id="fw-scale-values"
                  value={fwDraft.scaleValues}
                  onChange={(e) => setFwDraft({ ...fwDraft, scaleValues: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="fw-scale-proficient">{t('compScaleProficient')}</Label>
                <Input
                  id="fw-scale-proficient"
                  value={fwDraft.scaleProficient}
                  onChange={(e) => setFwDraft({ ...fwDraft, scaleProficient: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={fwDraft.visible}
                  onChange={(e) => setFwDraft({ ...fwDraft, visible: e.target.checked })}
                />
                {t('compFrameworkVisible')}
              </label>
              <Button type="submit">{t('compCreateFramework')}</Button>
            </form>
            <form onSubmit={(e) => void importFramework(e)} className="space-y-3">
              <h4 className="font-medium">{t('compImportTitle')}</h4>
              <div className="space-y-1">
                <Label htmlFor="fw-import-file">{t('compImportFile')}</Label>
                <Input
                  key={importInputKey}
                  id="fw-import-file"
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
              </div>
              {importError ? <p role="alert">{importError}</p> : null}
              <Button type="submit" variant="outline" disabled={!importFile}>
                {t('compImportAction')}
              </Button>
            </form>
          </div>

          <div className="space-y-3">
            <h3 className="font-medium">{t('compCompetenciesTitle')}</h3>
            {selectedFrameworkId ? (
              <>
                <ul className="space-y-1" aria-label={t('compCompetenciesTitle')}>
                  {competencies.map((c) => (
                    <li
                      key={c.id}
                      className={`text-sm ${COMPETENCY_INDENT[Math.min(Math.max(0, (c.depth ?? 1) - 1), 5)]}`}
                    >
                      <span className="font-medium">{c.shortname}</span>
                      {c.description ? <span> — {c.description}</span> : null}
                    </li>
                  ))}
                  {competencies.length === 0 ? <li className="text-sm">{t('compNoCompetencies')}</li> : null}
                </ul>
                <form onSubmit={(e) => void createCompetency(e)} className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="comp-shortname">{t('compCompetencyShortname')}</Label>
                    <Input
                      id="comp-shortname"
                      value={compDraft.shortname}
                      onChange={(e) => setCompDraft({ ...compDraft, shortname: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="comp-idnumber">{t('compCompetencyIdnumber')}</Label>
                    <Input
                      id="comp-idnumber"
                      value={compDraft.idnumber}
                      onChange={(e) => setCompDraft({ ...compDraft, idnumber: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="comp-description">{t('compCompetencyDescription')}</Label>
                    <Input
                      id="comp-description"
                      value={compDraft.description}
                      onChange={(e) => setCompDraft({ ...compDraft, description: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="comp-parent">{t('compCompetencyParent')}</Label>
                    <select
                      id="comp-parent"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                      value={compDraft.parentId}
                      onChange={(e) => setCompDraft({ ...compDraft, parentId: e.target.value })}
                    >
                      <option value="">{t('compNoParent')}</option>
                      {competencies.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.shortname}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button type="submit">{t('compAddCompetency')}</Button>
                </form>
              </>
            ) : (
              <p className="text-sm">{t('compSelectFramework')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('compTemplatesTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-1" aria-label={t('compTemplatesTitle')}>
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{tpl.shortname}</span>
                {tpl.id === selectedTemplateId ? (
                  <Badge>{t('compSelectTemplate')}</Badge>
                ) : (
                  <Button type="button" variant="outline" onClick={() => setSelectedTemplateId(tpl.id)}>
                    {t('view')}
                  </Button>
                )}
              </li>
            ))}
            {templates.length === 0 ? <li className="text-sm">{t('compNoTemplates')}</li> : null}
          </ul>
          <form onSubmit={(e) => void createTemplate(e)} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tpl-shortname">{t('compTemplateShortname')}</Label>
              <Input
                id="tpl-shortname"
                value={tplDraft.shortname}
                onChange={(e) => setTplDraft({ ...tplDraft, shortname: e.target.value })}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-description">{t('compTemplateDescription')}</Label>
              <Input
                id="tpl-description"
                value={tplDraft.description}
                onChange={(e) => setTplDraft({ ...tplDraft, description: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tpl-duedate">{t('compTemplateDuedate')}</Label>
              <Input
                id="tpl-duedate"
                type="date"
                value={tplDraft.duedate}
                onChange={(e) => setTplDraft({ ...tplDraft, duedate: e.target.value })}
              />
            </div>
            <Button type="submit">{t('compCreateTemplate')}</Button>
          </form>
          {selectedTemplateId ? (
            <div className="space-y-3">
              <form onSubmit={(e) => void addTemplateCompetency(e)} className="space-y-2">
                <Label htmlFor="tpl-competency-id">{t('compTemplateCompetencyId')}</Label>
                <Input
                  id="tpl-competency-id"
                  value={tplCompetencyId}
                  onChange={(e) => setTplCompetencyId(e.target.value)}
                  required
                />
                <Button type="submit" variant="outline">
                  {t('compAddTemplateCompetency')}
                </Button>
              </form>
              <form onSubmit={(e) => void addTemplateCohort(e)} className="space-y-2">
                <Label htmlFor="tpl-cohort-id">{t('compTemplateCohortId')}</Label>
                <Input
                  id="tpl-cohort-id"
                  value={tplCohortId}
                  onChange={(e) => setTplCohortId(e.target.value)}
                  required
                />
                <Button type="submit" variant="outline">
                  {t('compAddTemplateCohort')}
                </Button>
              </form>
              <Button type="button" onClick={() => void createPlansFromTemplate()}>
                {t('compCreatePlansFromTemplate')}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('compReviewQueueTitle')}</CardTitle>
          <CardDescription>{t('compReviewQueueDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            {users.length > 0 ? (
              <div className="space-y-1">
                <Label htmlFor="review-user-select">{t('compReviewUser')}</Label>
                <select
                  id="review-user-select"
                  className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={reviewUserId}
                  onChange={(e) => setReviewUserId(e.target.value)}
                >
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username} ({u.id})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="review-user-id">{t('compReviewUserId')}</Label>
              <Input id="review-user-id" value={reviewUserId} onChange={(e) => setReviewUserId(e.target.value)} />
            </div>
            <Button
              type="button"
              onClick={() =>
                void loadReviewQueue(reviewUserId).catch(() => setAdminMessage(t('compReviewQueueLoadFailed')))
              }
            >
              {t('compLoadReviewQueue')}
            </Button>
          </div>
          {reviewPlans !== null ? (
            <div className="space-y-2">
              <h3 className="font-medium">{t('compReviewPlansTitle')}</h3>
              <ul className="space-y-1" aria-label={t('compReviewPlansTitle')}>
                {reviewPlans.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                    {p.status === 2 ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void planReviewAction(p.id, 'start-review')}
                      >
                        {t('compStartReview')}
                      </Button>
                    ) : null}
                    {p.status === 3 ? (
                      <Button type="button" variant="outline" onClick={() => void planReviewAction(p.id, 'approve')}>
                        {t('compApprovePlan')}
                      </Button>
                    ) : null}
                    {p.status === 1 ? (
                      <Button type="button" variant="outline" onClick={() => void planReviewAction(p.id, 'unapprove')}>
                        {t('compUnapprovePlan')}
                      </Button>
                    ) : null}
                    {p.status === 1 || p.status === 3 ? (
                      <Button type="button" variant="outline" onClick={() => void planReviewAction(p.id, 'complete')}>
                        {t('compCompletePlan')}
                      </Button>
                    ) : null}
                  </li>
                ))}
                {reviewPlans.length === 0 ? <li className="text-sm">{t('compNoPlansForUser')}</li> : null}
              </ul>
            </div>
          ) : null}
          {reviewUsercomps !== null ? (
            <div className="space-y-2">
              <h3 className="font-medium">{t('compReviewUsercompsTitle')}</h3>
              <ul className="space-y-1" aria-label={t('compReviewUsercompsTitle')}>
                {reviewUsercomps.map((uc) => (
                  <li key={uc.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{t('compUsercompCompetency', { id: uc.competencyid })}</span>
                    <span>{REVIEW_STATUS[uc.status] ?? uc.status}</span>
                    <span>
                      {uc.proficiency == null
                        ? t('proficiencyNotYet')
                        : uc.proficiency
                          ? t('proficiencyYes')
                          : t('proficiencyNo')}
                    </span>
                    {uc.grade !== null ? <span>{t('compUsercompGrade', { grade: uc.grade })}</span> : null}
                    {uc.status === 1 ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void usercompReviewAction(uc.id, 'start-review')}
                      >
                        {t('compStartReview')}
                      </Button>
                    ) : null}
                    {uc.status === 1 || uc.status === 2 ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void usercompReviewAction(uc.id, 'approve')}
                      >
                        {t('compApproveUsercomp')}
                      </Button>
                    ) : null}
                    {uc.status === 1 || uc.status === 2 ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void usercompReviewAction(uc.id, 'reject')}
                      >
                        {t('compRejectUsercomp')}
                      </Button>
                    ) : null}
                  </li>
                ))}
                {reviewUsercomps.length === 0 ? <li className="text-sm">{t('compNoUsercompsForUser')}</li> : null}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

/**
 * Learning plans: the learner sees their plans, each competency's
 * proficiency (decided by the framework scale, never inferred from grades)
 * and review state, and can request a review of a competency — the action
 * that starts the reviewer workflow.
 */
export function LearningPlanPage() {
  const { t } = useTranslation('app');
  const PLAN_STATUS: Record<number, string> = {
    0: t('planStatusDraft'),
    1: t('planStatusActive'),
    2: t('planStatusWaiting'),
    3: t('planStatusInReview'),
    4: t('planStatusComplete'),
  };
  const REVIEW_STATUS: Record<number, string> = {
    0: t('reviewStatusNone'),
    1: t('reviewStatusWaiting'),
    2: t('reviewStatusInReview'),
  };
  const { user } = useAuth();
  const perms = usePermissions();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  /** Cột của bảng năng lực trong một kế hoạch trên DataTable dùng chung: sắp xếp/lọc theo tên năng lực và mức thành thạo, thao tác gửi duyệt giữ nguyên ở cột cuối. */
  const planCompetencyColumns: DataColumn<PlanDetail['competencies'][number]>[] = [
    {
      id: 'competency',
      header: t('competency'),
      cell: (row) => row.competency.shortname,
      sortValue: (row) => row.competency.shortname,
      filterValue: (row) => row.competency.shortname,
    },
    {
      id: 'proficiency',
      header: t('proficiency'),
      cell: (row) =>
        row.usercomp?.proficiency == null
          ? t('proficiencyNotYet')
          : row.usercomp.proficiency
            ? t('proficiencyYes')
            : t('proficiencyNo'),
      sortValue: (row) => (row.usercomp?.proficiency == null ? -1 : row.usercomp.proficiency ? 1 : 0),
    },
    {
      id: 'review',
      header: t('review'),
      cell: (row) => (row.usercomp ? (REVIEW_STATUS[row.usercomp.status] ?? row.usercomp.status) : '—'),
    },
    {
      id: 'actions',
      header: '',
      cell: (row) =>
        row.usercomp && row.usercomp.status === 0 ? (
          <Button type="button" variant="outline" onClick={() => void requestCompetencyReview(row.usercomp!.id)}>
            {t('sendForReview')}
          </Button>
        ) : null,
    },
  ];
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!user) return;
    const list = await apiJson<PlanView[]>(`/api/v1/competencies/plans/user/${user.id}`);
    setPlans(list);
  }, [user]);

  useEffect(() => {
    void reload().catch(() => setError(t('plansLoadFailed')));
  }, [reload]);

  async function open(plan: PlanView) {
    const d = await apiJson<PlanDetail>(`/api/v1/competencies/plans/${plan.id}`);
    setDetail(d);
  }

  async function requestReview(planId: string) {
    await apiJson(`/api/v1/competencies/plans/${planId}/request-review`, { method: 'POST', body: '{}' });
    setMessage(t('reviewRequested'));
    await reload();
  }

  async function requestCompetencyReview(usercompId: string) {
    await apiJson(`/api/v1/competencies/usercomp/${usercompId}/evidence`, {
      method: 'POST',
      body: JSON.stringify({ action: 'evidence', description: t('evidenceReviewDescription'), sendForReview: true }),
    });
    setMessage(t('competencySentForReview'));
    if (detail) await open(detail.plan);
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      {error ? <p role="alert">{error}</p> : null}
      {message ? <p>{message}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('myLearningPlans')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <ul className="space-y-1" aria-label={t('learningPlansLabel')}>
            {plans.map((p) => (
              <li key={p.id} className="flex items-center gap-3 text-sm">
                <span className="font-medium">{p.name}</span>
                <span>{PLAN_STATUS[p.status] ?? p.status}</span>
                <Button type="button" variant="outline" onClick={() => void open(p)}>
                  {t('view')}
                </Button>
                {p.status === 1 ? (
                  <Button type="button" variant="outline" onClick={() => void requestReview(p.id)}>
                    {t('requestPlanReview')}
                  </Button>
                ) : null}
              </li>
            ))}
            {plans.length === 0 ? <li>{t('noLearningPlans')}</li> : null}
          </ul>
        </CardContent>
      </Card>
      {detail ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('planCompetenciesTitle', { name: detail.plan.name })}</CardTitle>
          </CardHeader>
          <DataTable
            data={detail.competencies}
            columns={planCompetencyColumns}
            labels={{
              columns: t('dashboard:tableColumns'),
              previous: t('dashboard:tablePrevious'),
              next: t('dashboard:tableNext'),
              empty: t('dashboard:emptyTable'),
              filterPlaceholder: t('dashboard:tableFilterPlaceholder'),
              pageInfo: (page, pages) => t('dashboard:tablePageInfo', { page, pages }),
            }}
            getRowId={(row) => row.competency.id}
          />
        </Card>
      ) : null}
      {perms.canAdminister ? <CompetencyAdmin /> : null}
    </main>
  );
}

/** Export mặc định cho route module React Router framework mode (xem src/routes.ts). */
export default LearningPlanPage; /** Thụt lề theo độ sâu cây năng lực: bảng class tĩnh theo từng cấp (mỗi cấp 16px), tránh style nội tuyến. */
const COMPETENCY_INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'];
