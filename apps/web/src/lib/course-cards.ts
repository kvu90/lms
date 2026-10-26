import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COURSE_CARD_COLORS,
  type CourseCardColor,
  type CourseCardPrefView,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Thẻ khoá cá nhân (DASH1, issue #121): màu + biệt danh người dùng tự đặt
 * cho khoá của mình. Pref chỉ thuộc về chủ nhân — tên gốc của khoá không
 * bao giờ bị ghi đè; nơi hiển thị dùng biệt danh thay tên gốc (giữ tên gốc
 * ở title) và chấm/viền màu theo token đã chọn.
 */
export const COURSE_CARD_COLOR_HEX: Record<CourseCardColor, string> = {
  red: '#dc2626',
  orange: '#ea580c',
  amber: '#d97706',
  green: '#16a34a',
  teal: '#0d9488',
  blue: '#2563eb',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  pink: '#db2777',
  slate: '#64748b',
};

export { COURSE_CARD_COLORS };
export type { CourseCardColor, CourseCardPrefView };

/** Tải toàn bộ pref thẻ khoá của chính người dùng (1 request, không theo khoá). */
export async function fetchCourseCardPrefs(): Promise<Map<string, CourseCardPrefView>> {
  const data = await apiJson<{ prefs: CourseCardPrefView[] }>('/api/v1/dashboard/course-cards');
  return new Map(data.prefs.map((p) => [p.courseId, p]));
}

/** Hook đọc pref thẻ khoá cho các trang đã dùng TanStack Query (dashboard). */
export function useCourseCardPrefs() {
  return useQuery({
    queryKey: queryKeys.courseCards,
    queryFn: fetchCourseCardPrefs,
  });
}

/** Lưu pref thẻ khoá (color/nickname null = xoá giá trị đó). */
export async function saveCourseCardPref(
  courseId: string,
  body: { color: CourseCardColor | null; nickname: string | null },
): Promise<CourseCardPrefView> {
  return apiJson<CourseCardPrefView>(`/api/v1/dashboard/course-cards/${courseId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Mutation lưu pref thẻ khoá (F-04, rà soát #133): lưu qua
 * `useMutation` thay vì async thủ công ở component; thành công thì
 * invalidate khoá `courseCards` để mọi bề mặt đọc pref (dashboard,
 * danh sách khoá) tự tươi lại. Component vẫn nhận pref vừa lưu qua
 * callback `onSuccess` của lần mutate để cập nhật tại chỗ.
 */
export function useSaveCourseCardPref() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      courseId: string;
      body: { color: CourseCardColor | null; nickname: string | null };
    }) => saveCourseCardPref(vars.courseId, vars.body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.courseCards }),
  });
}

/** Tên hiển thị của khoá theo pref: biệt danh nếu có, không thì tên gốc. */
export function displayCourseName(pref: CourseCardPrefView | undefined, fullName: string): string {
  return pref?.nickname?.trim() ? pref.nickname : fullName;
}
