import type { Dispatch, FormEvent, SetStateAction } from 'react';
import {
  COURSE_CONTENT_TYPES,
  type CourseContent, type CourseGroup, type CourseGrouping, type GradeItem,
} from '@lms/contracts';
import { AvailabilityEditor } from './availability-editor';
import { LibraryItem } from '#features/content-bank/types/content-bank';
import { Badge } from '@lms/ui/components/badge';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { CardDescription } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';
import {
  bankItemInsertable, bankScopeKey, bankTypeKey, moveItem, statusChoiceOf, type ItemStatusChoice,
} from '../utils/utils';

type Section = CourseContent['sections'][number];
type ItemEdit = { name: string; status: ItemStatusChoice; openAt: string };

interface OutlineCardProps {
  content: CourseContent | null;
  sections: Section[];
  newSectionName: string;
  setNewSectionName: Dispatch<SetStateAction<string>>;
  onCreateSection: (event: FormEvent) => void;
  collapsed: Record<string, boolean>;
  setCollapsed: Dispatch<SetStateAction<Record<string, boolean>>>;
  dragSectionId: string | null;
  setDragSectionId: Dispatch<SetStateAction<string | null>>;
  dragModule: { sectionId: string; moduleId: string } | null;
  setDragModule: Dispatch<SetStateAction<{ sectionId: string; moduleId: string } | null>>;
  sectionEdits: Record<string, ItemEdit>;
  setSectionEdits: Dispatch<SetStateAction<Record<string, ItemEdit>>>;
  moduleEdits: Record<string, ItemEdit>;
  setModuleEdits: Dispatch<SetStateAction<Record<string, ItemEdit>>>;
  moduleDrafts: Record<string, { component: string; name: string }>;
  setModuleDrafts: Dispatch<SetStateAction<Record<string, { component: string; name: string }>>>;
  onSaveSection: (sectionId: string) => void;
  onDeleteSection: (sectionId: string, name: string) => void;
  onDuplicateSection: (sectionId: string) => void;
  onReorderSections: (ids: string[]) => void;
  onReorderModules: (sectionId: string, ids: string[]) => void;
  onSaveModule: (moduleId: string) => void;
  onDeleteModule: (moduleId: string, name: string) => void;
  onDuplicateModule: (moduleId: string) => void;
  onCreateModule: (event: FormEvent, sectionId: string) => void;
  groups: CourseGroup[];
  groupings: CourseGrouping[];
  gradeItems: GradeItem[];
  setAvailabilityDrafts: Dispatch<SetStateAction<Record<string, unknown>>>;
  onSaveSectionAvailability: (sectionId: string) => void;
  onSaveModuleAvailability: (moduleId: string) => void;
  bankOpenSectionId: string | null;
  onToggleBankPanel: (sectionId: string) => void;
  bankQuery: string;
  setBankQuery: Dispatch<SetStateAction<string>>;
  bankLoadError: string | null;
  bankItems: LibraryItem[] | null;
  bankFiltered: LibraryItem[];
  bankBusyId: string | null;
  onInsertFromBank: (item: LibraryItem, sectionId: string) => void;
  selectClass: string;
  statusBadge: (status: string | undefined) => string;
}

/** Thẻ cây nội dung (outline) của trang Xây dựng khoá: section/module, kéo–thả, kho học liệu, availability. */
export function OutlineCard(props: OutlineCardProps) {
  const { t } = useTranslation('app');
  const {
    content, sections, newSectionName, setNewSectionName, collapsed, setCollapsed, dragSectionId,
    setDragSectionId, dragModule, setDragModule, sectionEdits, setSectionEdits, moduleEdits,
    setModuleEdits, moduleDrafts, setModuleDrafts, groups, groupings, gradeItems,
    setAvailabilityDrafts, bankOpenSectionId, bankQuery, setBankQuery, bankLoadError, bankItems,
    bankFiltered, bankBusyId, selectClass, statusBadge,
  } = props;
  const createSection = props.onCreateSection;
  const saveSection = props.onSaveSection;
  const deleteSection = props.onDeleteSection;
  const duplicateSection = props.onDuplicateSection;
  const reorderSections = props.onReorderSections;
  const reorderModules = props.onReorderModules;
  const saveModule = props.onSaveModule;
  const deleteModule = props.onDeleteModule;
  const duplicateModule = props.onDuplicateModule;
  const createModule = props.onCreateModule;
  const saveSectionAvailability = props.onSaveSectionAvailability;
  const saveModuleAvailability = props.onSaveModuleAvailability;
  const toggleBankPanel = props.onToggleBankPanel;
  const insertFromBank = props.onInsertFromBank;
  return (
      <Card>
        <CardHeader>
          <CardTitle>{t('builderOutlineTitle')}</CardTitle>
          <CardDescription>{t('builderOutlineDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <form onSubmit={(e) => void createSection(e)} className="space-y-2">
            <Label htmlFor="new-section-name">{t('newSectionName')}</Label>
            <Input id="new-section-name" value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)} />
            <Button type="submit">{t('createSection')}</Button>
          </form>
          {content && sections.length === 0 ? <p>{t('noSections')}</p> : null}
          {sections.map((section, sectionIndex) => {
            const edit = sectionEdits[section.id] ?? {
              name: section.name ?? '',
              status: statusChoiceOf(section.visible, section.openAt),
              openAt: section.openAt ? String(section.openAt).slice(0, 10) : '',
            };
            const draft = moduleDrafts[section.id] ?? { component: 'mod_page', name: '' };
            const displayName = section.name ?? t('sectionDefaultName', { number: section.section });
            const isCollapsed = collapsed[section.id] ?? false;
            return (
              <div
                key={section.id}
                data-testid={`section-builder-${section.id}`}
                className="space-y-3 rounded border p-3"
                draggable
                onDragStart={() => setDragSectionId(section.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragSectionId || dragSectionId === section.id) return;
                  const from = sections.findIndex((s) => s.id === dragSectionId);
                  if (from < 0) return;
                  void reorderSections(moveItem(sections, from, sectionIndex).map((s) => s.id));
                  setDragSectionId(null);
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t('builderToggleSection')}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [section.id]: !isCollapsed }))}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </Button>
                  <span className="font-medium">{displayName}</span>
                  <span className="rounded bg-accent px-2 py-0.5 text-xs">{statusBadge(section.status)}</span>
                  {section.openAt ? (
                    <span className="text-xs text-muted-foreground">
                      {t('builderOpenAtLabel', { date: String(section.openAt).slice(0, 10) })}
                    </span>
                  ) : null}
                  <span className="ml-auto flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('builderMoveUp')}
                      disabled={sectionIndex === 0}
                      onClick={() => void reorderSections(moveItem(sections, sectionIndex, sectionIndex - 1).map((s) => s.id))}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('builderMoveDown')}
                      disabled={sectionIndex === sections.length - 1}
                      onClick={() => void reorderSections(moveItem(sections, sectionIndex, sectionIndex + 1).map((s) => s.id))}
                    >
                      ↓
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => void duplicateSection(section.id)}>
                      {t('builderDuplicate')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => void deleteSection(section.id, displayName)}
                    >
                      {t('deleteSection')}
                    </Button>
                  </span>
                </div>
                {!isCollapsed ? (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor={`section-name-${section.id}`}>{t('sectionName')}</Label>
                      <Input
                        id={`section-name-${section.id}`}
                        value={edit.name}
                        onChange={(e) => setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, name: e.target.value } }))}
                      />
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`section-status-${section.id}`}>{t('builderStatusLabel')}</Label>
                          <select
                            id={`section-status-${section.id}`}
                            className={selectClass}
                            value={edit.status}
                            onChange={(e) =>
                              setSectionEdits((prev) => ({
                                ...prev,
                                [section.id]: { ...edit, status: e.target.value as ItemStatusChoice },
                              }))
                            }
                          >
                            <option value="draft">{t('builderStatusDraft')}</option>
                            <option value="open">{t('builderStatusOpen')}</option>
                            <option value="scheduled">{t('builderStatusScheduled')}</option>
                          </select>
                        </div>
                        {edit.status === 'scheduled' ? (
                          <div className="space-y-1">
                            <Label htmlFor={`section-openat-${section.id}`}>{t('builderOpenAtField')}</Label>
                            <Input
                              id={`section-openat-${section.id}`}
                              type="date"
                              value={edit.openAt}
                              onChange={(e) =>
                                setSectionEdits((prev) => ({ ...prev, [section.id]: { ...edit, openAt: e.target.value } }))
                              }
                            />
                          </div>
                        ) : null}
                        <Button type="button" variant="outline" size="sm" onClick={() => void saveSection(section.id)}>
                          {t('saveSection')}
                        </Button>
                      </div>
                    </div>
                    <ul className="space-y-3">
                      {section.modules.map((cm, moduleIndex) => {
                        const mEdit = moduleEdits[cm.id] ?? {
                          name: cm.name,
                          status: statusChoiceOf(cm.visible, cm.openAt),
                          openAt: cm.openAt ? String(cm.openAt).slice(0, 10) : '',
                        };
                        return (
                          <li
                            key={cm.id}
                            data-testid={`module-builder-${cm.id}`}
                            className="space-y-2 rounded border p-2"
                            draggable
                            onDragStart={() => setDragModule({ sectionId: section.id, moduleId: cm.id })}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => {
                              if (!dragModule || dragModule.sectionId !== section.id || dragModule.moduleId === cm.id) return;
                              const from = section.modules.findIndex((m) => m.id === dragModule.moduleId);
                              if (from < 0) return;
                              void reorderModules(section.id, moveItem(section.modules, from, moduleIndex).map((m) => m.id));
                              setDragModule(null);
                            }}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-medium">
                                {cm.name || cm.component}{' '}
                                <span className="text-muted-foreground">({t(`contentType_${cm.component}`, { defaultValue: cm.component })})</span>
                              </p>
                              <span className="rounded bg-accent px-2 py-0.5 text-xs">{statusBadge(cm.status)}</span>
                              <span className="ml-auto flex gap-1">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  aria-label={t('builderMoveUp')}
                                  disabled={moduleIndex === 0}
                                  onClick={() =>
                                    void reorderModules(section.id, moveItem(section.modules, moduleIndex, moduleIndex - 1).map((m) => m.id))
                                  }
                                >
                                  ↑
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  aria-label={t('builderMoveDown')}
                                  disabled={moduleIndex === section.modules.length - 1}
                                  onClick={() =>
                                    void reorderModules(section.id, moveItem(section.modules, moduleIndex, moduleIndex + 1).map((m) => m.id))
                                  }
                                >
                                  ↓
                                </Button>
                                <Button type="button" variant="outline" size="sm" onClick={() => void duplicateModule(cm.id)}>
                                  {t('builderDuplicate')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => void deleteModule(cm.id, cm.name || cm.component)}
                                >
                                  {t('deleteModule')}
                                </Button>
                              </span>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor={`module-name-${cm.id}`}>{t('moduleName')}</Label>
                              <Input
                                id={`module-name-${cm.id}`}
                                value={mEdit.name}
                                onChange={(e) => setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, name: e.target.value } }))}
                              />
                              <div className="flex flex-wrap items-end gap-2">
                                <div className="space-y-1">
                                  <Label htmlFor={`module-status-${cm.id}`}>{t('builderStatusLabel')}</Label>
                                  <select
                                    id={`module-status-${cm.id}`}
                                    className={selectClass}
                                    value={mEdit.status}
                                    onChange={(e) =>
                                      setModuleEdits((prev) => ({
                                        ...prev,
                                        [cm.id]: { ...mEdit, status: e.target.value as ItemStatusChoice },
                                      }))
                                    }
                                  >
                                    <option value="draft">{t('builderStatusDraft')}</option>
                                    <option value="open">{t('builderStatusOpen')}</option>
                                    <option value="scheduled">{t('builderStatusScheduled')}</option>
                                  </select>
                                </div>
                                {mEdit.status === 'scheduled' ? (
                                  <div className="space-y-1">
                                    <Label htmlFor={`module-openat-${cm.id}`}>{t('builderOpenAtField')}</Label>
                                    <Input
                                      id={`module-openat-${cm.id}`}
                                      type="date"
                                      value={mEdit.openAt}
                                      onChange={(e) =>
                                        setModuleEdits((prev) => ({ ...prev, [cm.id]: { ...mEdit, openAt: e.target.value } }))
                                      }
                                    />
                                  </div>
                                ) : null}
                                <Button type="button" variant="outline" size="sm" onClick={() => void saveModule(cm.id)}>
                                  {t('saveModule')}
                                </Button>
                              </div>
                              <div className="space-y-2" data-testid={`module-availability-${cm.id}`}>
                                <h5 className="text-sm font-medium">{t('availabilityTitle')}</h5>
                                <AvailabilityEditor
                                  key={`module-availability-editor-${cm.id}`}
                                  value={cm.availability}
                                  onChange={(next) => setAvailabilityDrafts((prev) => ({ ...prev, [`module:${cm.id}`]: next }))}
                                  groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                                  groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                                  modules={sections.flatMap((s) => s.modules.map((m) => ({ id: m.id, name: m.name || m.component })))}
                                  gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                                />
                                <Button type="button" variant="outline" size="sm" onClick={() => void saveModuleAvailability(cm.id)}>
                                  {t('availabilitySave')}
                                </Button>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                      {section.modules.length === 0 ? <li className="text-sm text-muted-foreground">{t('noModulesInSection')}</li> : null}
                    </ul>
                    <form onSubmit={(e) => void createModule(e, section.id)} className="space-y-2">
                      <div className="space-y-2">
                        <Label htmlFor={`module-type-${section.id}`}>{t('builderContentType')}</Label>
                        <select
                          id={`module-type-${section.id}`}
                          className={selectClass}
                          value={draft.component}
                          onChange={(e) =>
                            setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, component: e.target.value } }))
                          }
                        >
                          {COURSE_CONTENT_TYPES.map((type) => (
                            <option key={type.component} value={type.component}>
                              {t(`contentType_${type.component}`, { defaultValue: type.component })}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`module-new-name-${section.id}`}>{t('moduleName')}</Label>
                        <Input
                          id={`module-new-name-${section.id}`}
                          value={draft.name}
                          onChange={(e) => setModuleDrafts((prev) => ({ ...prev, [section.id]: { ...draft, name: e.target.value } }))}
                        />
                      </div>
                      <Button type="submit" variant="outline">
                        {t('addModule')}
                      </Button>
                    </form>
                    <div className="space-y-2" data-testid={`section-bank-${section.id}`}>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-expanded={bankOpenSectionId === section.id}
                        onClick={() => void toggleBankPanel(section.id)}
                      >
                        {t('builderAddFromBank')}
                      </Button>
                      {bankOpenSectionId === section.id ? (
                        <div className="space-y-2 rounded border p-2">
                          <div className="space-y-1">
                            <Label htmlFor={`bank-search-${section.id}`}>{t('builderBankSearchLabel')}</Label>
                            <Input
                              id={`bank-search-${section.id}`}
                              value={bankQuery}
                              onChange={(e) => setBankQuery(e.target.value)}
                              placeholder={t('builderBankSearchPlaceholder')}
                            />
                          </div>
                          {bankLoadError ? (
                            <p role="alert" className="text-sm">
                              {bankLoadError}
                            </p>
                          ) : bankItems === null ? (
                            <p className="text-sm text-muted-foreground">{t('loading')}</p>
                          ) : bankFiltered.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t('builderBankEmpty')}</p>
                          ) : (
                            <ul className="space-y-2">
                              {bankFiltered.map((item) => (
                                <li
                                  key={item.id}
                                  className="flex flex-wrap items-center gap-2 rounded border p-2"
                                  data-testid={`bank-item-${item.id}`}
                                >
                                  <span className="text-sm font-medium">{item.name}</span>
                                  <Badge variant="secondary">{t(bankTypeKey(item.resourceType))}</Badge>
                                  <span className="text-xs text-muted-foreground">{t(bankScopeKey(item.scope))}</span>
                                  {item.description ? (
                                    <span className="w-full text-xs text-muted-foreground">{item.description}</span>
                                  ) : null}
                                  {bankItemInsertable(item) ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="ml-auto"
                                      disabled={bankBusyId === item.id}
                                      onClick={() => void insertFromBank(item, section.id)}
                                    >
                                      {t('builderBankInsert')}
                                    </Button>
                                  ) : (
                                    <span className="ml-auto text-xs text-muted-foreground">{t('builderBankQuestionSetNote')}</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-2" data-testid={`section-availability-${section.id}`}>
                      <h4 className="text-sm font-medium">{t('availabilityTitle')}</h4>
                      <p className="text-sm text-muted-foreground">{t('availabilityDescription')}</p>
                      <AvailabilityEditor
                        key={`section-availability-editor-${section.id}`}
                        value={section.availability}
                        onChange={(next) => setAvailabilityDrafts((prev) => ({ ...prev, [`section:${section.id}`]: next }))}
                        groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                        groupings={groupings.map((g) => ({ id: g.id, name: g.name }))}
                        modules={sections.flatMap((s) => s.modules.map((m) => ({ id: m.id, name: m.name || m.component })))}
                        gradeItems={gradeItems.map((item) => ({ id: item.id, name: item.itemName }))}
                      />
                      <Button type="button" variant="outline" size="sm" onClick={() => void saveSectionAvailability(section.id)}>
                        {t('availabilitySave')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
  );
}
