import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import '../i18n';
import { ApiError } from '#lib/api';
import {
  fetchCurricula, fetchSubjects, fetchSystemContextId, fetchTree,
  type CurriculumSubject, type CurriculumTreeNode,
} from '#lib/curriculum';
import {
  LESSON_POSITIONS, LEVELS, RESOURCE_TYPES, SOURCE_KINDS, TARGET_AUDIENCES,
  createItem, fetchItem, fetchSpaces, fileToBase64, updateItem, uploadItemFile,
  type LibraryItemInput, type LibrarySpace,
} from '#lib/content-bank';
import { apiJson } from '#lib/api';

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm';

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (err.problem.detail ?? err.problem.title ?? fallback) : fallback;
}

interface FlatNode {
  id: string;
  title: string;
  kind: string;
  depth: number;
  outcomeIds: string[];
  outcomes: { id: string; content: string }[];
}

function flattenNodes(nodes: CurriculumTreeNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
  for (const node of nodes) {
    const subtreeOutcomes: { id: string; content: string }[] = [];
    const collect = (n: CurriculumTreeNode) => {
      for (const o of n.outcomes) subtreeOutcomes.push({ id: o.id, content: o.content });
      n.children.forEach(collect);
    };
    collect(node);
    out.push({ id: node.id, title: node.title, kind: node.kind, depth, outcomeIds: subtreeOutcomes.map((o) => o.id), outcomes: subtreeOutcomes });
    flattenNodes(node.children, depth + 1, out);
  }
  return out;
}

interface QuestionCategoryView {
  id: string;
  name: string;
}

/**
 * Màn tạo/sửa học liệu RIÊNG của Kho học liệu (CB-1, chuẩn §9 — không
 * nhồi form vào danh sách). Metadata chương trình lấy từ cây GDPT 2018
 * thật (môn → chương trình theo khối → node → YCCĐ trong subtree của
 * node). Loại "bộ câu hỏi" chỉ chọn category để THAM CHIẾU ngân hàng
 * câu hỏi. File chọn từ máy được tải lên sau khi lưu bản ghi (API
 * upload base64 sẵn có); học liệu chia sẻ đã/chờ duyệt bị sửa sẽ quay
 * về nháp ở phía server.
 */
export function ContentBankEditPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const [loaded, setLoaded] = useState(!editing);
  const [spaces, setSpaces] = useState<LibrarySpace[]>([]);
  const [subjects, setSubjects] = useState<CurriculumSubject[]>([]);
  const [categories, setCategories] = useState<QuestionCategoryView[]>([]);
  const [currentFileId, setCurrentFileId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [resourceType, setResourceType] = useState('multimedia_lecture');
  const [scope, setScope] = useState('personal');
  const [spaceId, setSpaceId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [grade, setGrade] = useState('');
  const [level, setLevel] = useState('');
  const [nodes, setNodes] = useState<FlatNode[]>([]);
  const [nodeId, setNodeId] = useState('');
  const [outcomeIds, setOutcomeIds] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [lessonPosition, setLessonPosition] = useState('');
  const [language, setLanguage] = useState('vi');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [originalAuthor, setOriginalAuthor] = useState('');
  const [sourceKind, setSourceKind] = useState('');
  const [sourceCitation, setSourceCitation] = useState('');
  const [license, setLicense] = useState('');
  const [derivedFromId, setDerivedFromId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [spaceRows, sys] = await Promise.all([fetchSpaces().catch(() => [] as LibrarySpace[]), fetchSystemContextId().catch(() => null)]);
      setSpaces(spaceRows);
      if (sys) {
        setSubjects(await fetchSubjects(sys).catch(() => []));
        const cats = await apiJson<QuestionCategoryView[]>(`/api/v1/questions/categories?contextId=${sys}`).catch(() => [] as QuestionCategoryView[]);
        setCategories(cats);
      }
      if (id) {
        try {
          const item = await fetchItem(id);
          setName(item.name);
          setResourceType(item.resourceType);
          setScope(item.scope);
          setSpaceId(item.spaceId ?? '');
          setSubjectId(item.subjectId ?? '');
          setGrade(item.grade ? String(item.grade) : '');
          setLevel(item.level ?? '');
          setNodeId(item.curriculumNodeId ?? '');
          setOutcomeIds(item.outcomeIds ?? []);
          setCategoryId(item.questionCategoryId ?? '');
          setExternalUrl(item.externalUrl ?? '');
          setDescription(item.description ?? '');
          setKeywords((item.keywords ?? []).join(', '));
          setTargetAudience(item.targetAudience ?? '');
          setLessonPosition(item.lessonPosition ?? '');
          setLanguage(item.language ?? 'vi');
          setDurationSeconds(item.durationSeconds ? String(item.durationSeconds) : '');
          setOriginalAuthor(item.originalAuthor ?? '');
          setSourceKind(item.sourceKind ?? '');
          setSourceCitation(item.sourceCitation ?? '');
          setLicense(item.license ?? '');
          setDerivedFromId(item.derivedFromId ?? '');
          setCurrentFileId(item.fileId);
        } catch (err) {
          setError(errorText(err, t('libraryLoadFailed')));
        }
        setLoaded(true);
      }
    })();
  }, [id, t]);

  // Nạp cây chương trình khi đã có môn + khối.
  useEffect(() => {
    void (async () => {
      if (!subjectId || !grade) {
        setNodes([]);
        return;
      }
      const curricula = await fetchCurricula(subjectId).catch(() => []);
      const curriculum = curricula.find((c) => c.grade === Number(grade));
      if (!curriculum) {
        setNodes([]);
        return;
      }
      const tree = await fetchTree(curriculum.id).catch(() => null);
      setNodes(tree ? flattenNodes(tree.nodes) : []);
    })();
  }, [subjectId, grade]);

  const selectedNode = useMemo(() => nodes.find((n) => n.id === nodeId) ?? null, [nodes, nodeId]);
  const orgSpaces = spaces.filter((s) => s.scope === 'org');

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      const payload: LibraryItemInput = { name, resourceType, scope };
      if (scope === 'org' && spaceId) payload.spaceId = spaceId;
      if (subjectId) payload.subjectId = subjectId;
      if (grade) payload.grade = Number(grade);
      if (level) payload.level = level;
      if (nodeId) payload.curriculumNodeId = nodeId;
      if (outcomeIds.length) payload.outcomeIds = outcomeIds;
      if (resourceType === 'question_set' && categoryId) payload.questionCategoryId = categoryId;
      if (externalUrl) payload.externalUrl = externalUrl;
      if (description) payload.description = description;
      const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
      if (keywordList.length) payload.keywords = keywordList;
      if (targetAudience) payload.targetAudience = targetAudience;
      if (lessonPosition) payload.lessonPosition = lessonPosition;
      if (language) payload.language = language;
      if (durationSeconds) payload.durationSeconds = Number(durationSeconds);
      if (originalAuthor) payload.originalAuthor = originalAuthor;
      if (sourceKind) payload.sourceKind = sourceKind;
      if (sourceCitation) payload.sourceCitation = sourceCitation;
      if (license) payload.license = license;
      if (derivedFromId) payload.derivedFromId = derivedFromId;
      try {
        const item = editing && id ? await updateItem(id, payload) : await createItem(payload);
        if (file) {
          const contentBase64 = await fileToBase64(file);
          await uploadItemFile(item.id, file.name, contentBase64, file.type || undefined);
        }
        navigate('/contentbank');
      } catch (err) {
        setError(errorText(err, t('libraryActionFailed')));
      } finally {
        setBusy(false);
      }
    },
    [name, resourceType, scope, spaceId, subjectId, grade, level, nodeId, outcomeIds, categoryId, externalUrl, description, keywords, targetAudience, lessonPosition, language, durationSeconds, originalAuthor, sourceKind, sourceCitation, license, derivedFromId, file, editing, id, navigate, t],
  );

  if (!loaded) {
    return (
      <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 lg:px-6">
        <p>{t('libraryTitle')}…</p>
      </main>
    );
  }

  return (
    <main className="@container/main flex flex-1 flex-col gap-4 px-4 py-4 md:gap-6 md:py-6 lg:px-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{editing ? t('libraryFormTitleEdit') : t('libraryFormTitleNew')}</h1>
        <Link
          to="/contentbank"
          className="inline-flex h-9 items-center rounded-md border border-input bg-transparent px-4 text-sm"
        >
          {t('libraryFormBack')}
        </Link>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t('libraryFormMetadataHint')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-name">{t('libraryFormName')}</Label>
              <Input id="lib-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-type">{t('libraryFormType')}</Label>
              <select id="lib-type" className={SELECT_CLASS} value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                {RESOURCE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(
                      type === 'multimedia_lecture'
                        ? 'libraryTypeMultimediaLecture'
                        : type === 'lab_guide'
                          ? 'libraryTypeLabGuide'
                          : type === 'simulation'
                            ? 'libraryTypeSimulation'
                            : type === 'question_set'
                              ? 'libraryTypeQuestionSet'
                              : 'libraryTypeReference',
                    )}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-scope">{t('libraryFormScope')}</Label>
              <select id="lib-scope" className={SELECT_CLASS} value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="personal">{t('libraryScopePersonal')}</option>
                <option value="org">{t('libraryScopeOrg')}</option>
                <option value="school">{t('libraryScopeSchool')}</option>
              </select>
            </div>
            {scope === 'org' ? (
              <div className="space-y-1">
                <Label htmlFor="lib-space">{t('libraryFormOrg')}</Label>
                <select id="lib-space" className={SELECT_CLASS} value={spaceId} onChange={(e) => setSpaceId(e.target.value)} required>
                  <option value="">{t('libraryFormNone')}</option>
                  {orgSpaces.map((s) => (
                    <option key={s.spaceId ?? ''} value={s.spaceId ?? ''}>{s.name}</option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="lib-subject">{t('libraryFormSubject')}</Label>
              <select id="lib-subject" className={SELECT_CLASS} value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-grade">{t('libraryFormGrade')}</Label>
              <select id="lib-grade" className={SELECT_CLASS} value={grade} onChange={(e) => setGrade(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((g) => (
                  <option key={g} value={g}>{t('libraryGradeOption', { grade: g })}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-node">{t('libraryFormNode')}</Label>
              <select id="lib-node" className={SELECT_CLASS} value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {'— '.repeat(n.depth)}
                    {n.title}
                  </option>
                ))}
              </select>
            </div>
            {selectedNode && selectedNode.outcomes.length > 0 ? (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="lib-outcomes">{t('libraryFormOutcomes')}</Label>
                <select
                  id="lib-outcomes"
                  className="flex min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                  multiple
                  value={outcomeIds}
                  onChange={(e) => setOutcomeIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                >
                  {selectedNode.outcomes.map((o) => (
                    <option key={o.id} value={o.id}>{o.content}</option>
                  ))}
                </select>
              </div>
            ) : null}
            {resourceType === 'question_set' ? (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="lib-category">{t('libraryFormCategory')}</Label>
                <select id="lib-category" className={SELECT_CLASS} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">{t('libraryFormNone')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <p className="text-sm text-muted-foreground">{t('libraryFormCategoryHint')}</p>
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="lib-level">{t('libraryFormLevel')}</Label>
              <select id="lib-level" className={SELECT_CLASS} value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {LEVELS.map((lv) => (
                  <option key={lv} value={lv}>
                    {t(lv === 'primary' ? 'libraryLevelPrimary' : lv === 'lower_secondary' ? 'libraryLevelLowerSecondary' : lv === 'upper_secondary' ? 'libraryLevelUpperSecondary' : 'libraryLevelMulti')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-language">{t('libraryFormLanguage')}</Label>
              <Input id="lib-language" value={language} onChange={(e) => setLanguage(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-url">{t('libraryFormExternalUrl')}</Label>
              <Input id="lib-url" value={externalUrl} onChange={(e) => setExternalUrl(e.target.value)} placeholder="https://…" />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-description">{t('libraryFormDescription')}</Label>
              <Input id="lib-description" value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-keywords">{t('libraryFormKeywords')}</Label>
              <Input id="lib-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-audience">{t('libraryFormAudience')}</Label>
              <select id="lib-audience" className={SELECT_CLASS} value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {TARGET_AUDIENCES.map((a) => (
                  <option key={a} value={a}>
                    {t(a === 'students' ? 'libraryAudienceStudents' : a === 'teachers' ? 'libraryAudienceTeachers' : 'libraryAudienceBoth')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-position">{t('libraryFormPosition')}</Label>
              <select id="lib-position" className={SELECT_CLASS} value={lessonPosition} onChange={(e) => setLessonPosition(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {LESSON_POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(p === 'opening' ? 'libraryPositionOpening' : p === 'new_knowledge' ? 'libraryPositionNewKnowledge' : p === 'practice' ? 'libraryPositionPractice' : 'libraryPositionApplication')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-duration">{t('libraryFormDuration')}</Label>
              <Input id="lib-duration" type="number" min="0" value={durationSeconds} onChange={(e) => setDurationSeconds(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-author">{t('libraryFormOriginalAuthor')}</Label>
              <Input id="lib-author" value={originalAuthor} onChange={(e) => setOriginalAuthor(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-source-kind">{t('libraryFormSourceKind')}</Label>
              <select id="lib-source-kind" className={SELECT_CLASS} value={sourceKind} onChange={(e) => setSourceKind(e.target.value)}>
                <option value="">{t('libraryFormNone')}</option>
                {SOURCE_KINDS.map((s) => (
                  <option key={s} value={s}>
                    {t(s === 'self' ? 'librarySourceSelf' : s === 'cited' ? 'librarySourceCited' : 'librarySourceDerived')}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lib-license">{t('libraryFormLicense')}</Label>
              <Input id="lib-license" value={license} onChange={(e) => setLicense(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-citation">{t('libraryFormSourceCitation')}</Label>
              <Input id="lib-citation" value={sourceCitation} onChange={(e) => setSourceCitation(e.target.value)} />
            </div>
            {sourceKind === 'derived' ? (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="lib-derived">{t('libraryFormDerivedFrom')}</Label>
                <Input id="lib-derived" value={derivedFromId} onChange={(e) => setDerivedFromId(e.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="lib-file">{t('libraryFormFile')}</Label>
              <Input id="lib-file" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              {currentFileId ? <p className="text-sm text-muted-foreground">{t('libraryFormFileCurrent', { name: currentFileId })}</p> : null}
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={busy || !name}>
                {t('libraryFormSave')}
              </Button>
              <Link
                to="/contentbank"
                className="inline-flex h-9 items-center rounded-md border border-input bg-transparent px-4 text-sm"
              >
                {t('libraryFormCancel')}
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

export default ContentBankEditPage;
