import type { ContentBankContent } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Kiểu + lời gọi API của Kho học liệu (CB-1, issue #69).
 * Học liệu là `ContentBankContent` của contracts (đã gồm metadata
 * chương trình, scope và trạng thái duyệt); trang kho và màn tạo/sửa
 * dùng chung module này.
 */

export type LibraryItem = ContentBankContent;

export interface LibrarySpace {
  scope: string;
  spaceId: string | null;
  name: string;
  canReview: boolean;
}

/** Loại học liệu: đúng 5 nhóm Điều 7 TT 09/2021 (CB1-B2). */
export const RESOURCE_TYPES = ['multimedia_lecture', 'lab_guide', 'simulation', 'question_set', 'reference'] as const;
export const REVIEW_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export const LEVELS = ['primary', 'lower_secondary', 'upper_secondary', 'multi'] as const;
export const SOURCE_KINDS = ['self', 'cited', 'derived'] as const;
export const TARGET_AUDIENCES = ['students', 'teachers', 'both'] as const;
export const LESSON_POSITIONS = ['opening', 'new_knowledge', 'practice', 'application'] as const;

export interface ReviewChecklist {
  contentAccurate: boolean;
  sourceClear: boolean;
  pedagogyAesthetics: boolean;
  mobileReady: boolean;
}

export interface LibraryFilters {
  scope?: string;
  spaceId?: string | null;
  subjectId?: string;
  grade?: number;
  level?: string;
  resourceType?: string;
  reviewStatus?: string;
}

export function fetchSpaces(): Promise<LibrarySpace[]> {
  return apiJson<LibrarySpace[]>('/api/v1/contentbank/spaces');
}

export function fetchItems(filters: LibraryFilters = {}): Promise<LibraryItem[]> {
  const params = new URLSearchParams();
  if (filters.scope) params.set('scope', filters.scope);
  if (filters.spaceId) params.set('spaceId', filters.spaceId);
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.grade) params.set('grade', String(filters.grade));
  if (filters.level) params.set('level', filters.level);
  if (filters.resourceType) params.set('resourceType', filters.resourceType);
  if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus);
  const qs = params.toString();
  return apiJson<LibraryItem[]>(`/api/v1/contentbank${qs ? `?${qs}` : ''}`);
}

export function fetchItem(id: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}`);
}

export interface LibraryItemInput {
  name: string;
  resourceType?: string;
  scope?: string;
  spaceId?: string | null;
  subjectId?: string | null;
  grade?: number | null;
  level?: string | null;
  curriculumNodeId?: string | null;
  outcomeIds?: string[] | null;
  questionCategoryId?: string | null;
  externalUrl?: string | null;
  description?: string | null;
  keywords?: string[] | null;
  targetAudience?: string | null;
  lessonPosition?: string | null;
  techFormat?: string | null;
  durationSeconds?: number | null;
  language?: string | null;
  originalAuthor?: string | null;
  sourceKind?: string | null;
  sourceCitation?: string | null;
  license?: string | null;
  derivedFromId?: string | null;
}

export function createItem(input: LibraryItemInput): Promise<LibraryItem> {
  return apiJson<LibraryItem>('/api/v1/contentbank', { method: 'POST', body: JSON.stringify(input) });
}

export function updateItem(id: string, input: Partial<LibraryItemInput>): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteItem(id: string): Promise<{ deleted: boolean }> {
  return apiJson<{ deleted: boolean }>(`/api/v1/contentbank/${id}`, { method: 'DELETE' });
}

export function submitItem(id: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/submit`, { method: 'POST' });
}

export function reviewItem(id: string, decision: 'approved' | 'rejected', note?: string, checklist?: ReviewChecklist): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision, ...(note ? { note } : {}), ...(checklist ? { checklist } : {}) }),
  });
}

export function insertItem(id: string, courseId: string, sectionId: string): Promise<{ cmId: string; fileId: string | null }> {
  return apiJson<{ cmId: string; fileId: string | null }>(`/api/v1/contentbank/${id}/insert`, {
    method: 'POST',
    body: JSON.stringify({ courseId, sectionId }),
  });
}

export function uploadItemFile(id: string, fileName: string, contentBase64: string, mimeType?: string): Promise<LibraryItem> {
  return apiJson<LibraryItem>(`/api/v1/contentbank/${id}/file`, {
    method: 'POST',
    body: JSON.stringify({ fileName, contentBase64, ...(mimeType ? { mimeType } : {}) }),
  });
}

export function fetchItemFileUrl(id: string): Promise<{ url: string; expiresAt: number }> {
  return apiJson<{ url: string; expiresAt: number }>(`/api/v1/contentbank/${id}/file-url`);
}

/** Đọc File của input[type=file] thành base64 thuần (bỏ tiền tố data:...;base64,). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
