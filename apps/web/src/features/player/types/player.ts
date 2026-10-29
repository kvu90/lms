/**
 * Kiểu dữ liệu của trang học/player thuộc feature player. Tách từ
 * module dữ liệu phẳng `src/lib/player-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn và đột
 * biến ở tầng queries/.
 */

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
