import type { LibraryItem } from '#lib/content-bank';

export type ItemStatusChoice = 'draft' | 'open' | 'scheduled';

export function statusChoiceOf(visible: boolean, openAt: string | null | undefined): ItemStatusChoice {
  if (!visible) return 'draft';
  return openAt ? 'scheduled' : 'open';
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** Key i18n nhãn loại học liệu của Kho (CB-1) — dùng chung catalog platform với trang kho. */
export function bankTypeKey(resourceType: string): string {
  return resourceType === 'multimedia_lecture'
    ? 'platform:libraryTypeMultimediaLecture'
    : resourceType === 'lab_guide'
      ? 'platform:libraryTypeLabGuide'
      : resourceType === 'simulation'
        ? 'platform:libraryTypeSimulation'
        : resourceType === 'question_set'
          ? 'platform:libraryTypeQuestionSet'
          : 'platform:libraryTypeReference';
}

/** Key i18n nhãn phạm vi (không gian) của học liệu trong Kho. */
export function bankScopeKey(scope: string): string {
  return scope === 'org' ? 'platform:libraryScopeOrg' : scope === 'school' ? 'platform:libraryScopeSchool' : 'platform:libraryScopePersonal';
}

/**
 * Học liệu cắm được vào khoá: mọi học liệu trừ bộ câu hỏi THAM CHIẾU
 * (`question_set` không có file — chỉ tham chiếu Ngân hàng câu hỏi),
 * khớp đúng cổng ở endpoint insert của CB-1
 * (`contentbank.question_set_not_insertable`).
 */
export function bankItemInsertable(item: LibraryItem): boolean {
  return !(item.resourceType === 'question_set' && !item.fileId);
}
