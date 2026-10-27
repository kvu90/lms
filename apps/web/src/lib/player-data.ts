import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Một mục trong outline của player (từ progress/me). */
export interface PlayerOutlineItem {
  cmId: string;
  name: string;
  component: string;
  completion: number;
  state: number;
  viewed: boolean;
  done: boolean;
}

/** Dữ liệu player từ GET /courses/:id/player/:cmId. */
export interface PlayerView {
  course: { id: string; fullName: string; shortName: string };
  cm: { id: string; name: string; component: string; instanceId: string | null };
  content:
    | { type: 'page'; page: { id: string; name: string; content: string } }
    | {
        type: 'resource';
        resource: { id: string; name: string; kind: string; url: string | null; transcript: string | null };
        file: { id: string; fileName: string; mimeType: string | null; fileSize: number; signedUrl: string } | null;
        embedUrl: string | null;
      }
    | { type: 'other'; component: string };
  completion: { state: number; viewed: boolean; mode: 'view' | 'manual' | 'progress' | 'none' };
  itemProgress: { percent: number; positionSeconds: number | null; page: number | null } | null;
  progress: {
    percent: number | null;
    completed: number;
    total: number;
    sections: { sectionId: string; name: string | null; section: number; percent: number | null; items: PlayerOutlineItem[] }[];
  };
  prevCmId: string | null;
  nextCmId: string | null;
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Tầng dữ liệu trang học/player (F-01 đợt 1, rà soát #133): options
 * dùng chung cho hook của trang và clientLoader của route module.
 * queryFn giữ semantics probe: lỗi tải → null, trang hiển thị lỗi
 * tải như trước thay vì ném ra error boundary.
 */
export function playerViewQueryOptions(courseId: string, cmId: string) {
  return queryOptions({
    queryKey: queryKeys.playerView(courseId, cmId),
    queryFn: () => probe<PlayerView>(`/api/v1/courses/${courseId}/player/${cmId}`),
  });
}

/** Đọc dữ liệu player; thiếu `courseId`/`cmId` thì query tắt. */
export function usePlayerView(courseId: string | undefined, cmId: string | undefined) {
  return useQuery({
    ...playerViewQueryOptions(courseId ?? '', cmId ?? ''),
    enabled: !!courseId && !!cmId,
  });
}

/**
 * Đột biến "Đánh dấu đã học" cho mục hoàn thành thủ công: trước hết
 * probe completion của chính người dùng để lấy userId (endpoint
 * manual đòi userId trong thân), rồi POST completion/manual với
 * complete=true — đúng hai bước của bản thủ công. Thành công thì làm
 * mới view của player để trạng thái hoàn thành cập nhật.
 */
export function useMarkPlayerModuleLearned(courseId: string | undefined, cmId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const mine = await probe<{ course: { userId: string } }>(`/api/v1/courses/${courseId}/completion/me`);
      const userId = mine?.course.userId;
      if (!userId) throw new Error('no user');
      await apiJson(`/api/v1/courses/${courseId}/modules/${cmId}/completion/manual`, {
        method: 'POST',
        body: JSON.stringify({ userId, complete: true }),
      });
    },
    onSuccess: () => {
      if (courseId && cmId) {
        void client.invalidateQueries({ queryKey: queryKeys.playerView(courseId, cmId) });
      }
    },
  });
}
