import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiJson } from './api';
import {
  createItem, deleteItem, fetchItem, fetchItemFileUrl, fetchItems, fetchSpaces, insertItem, reviewItem,
  submitItem, updateItem, uploadItemFile,
  type LibraryItemInput, type ReviewChecklist,
} from './content-bank';
import {
  fetchCurricula, fetchSubjects, fetchSystemContextId, fetchTree,
  type CurriculumSubject, type CurriculumTreeNode,
} from './curriculum';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu TanStack Query cho Kho học liệu (F-01 của rà soát
 * #133): trang kho (`pages/content-bank.tsx`) và màn tạo/sửa
 * (`pages/content-bank-edit.tsx`) trước đây gọi thẳng các hàm fetch
 * của `lib/content-bank.ts`/`lib/curriculum.ts` trong `useEffect` và
 * tự giữ kết quả bằng `useState`. Nay mọi lần đọc đi qua options của
 * module này với khoá lấy từ nhà máy `queryKeys`, các thao tác ghi đi
 * qua hook đột biến và invalidate đúng cụm khoá kho học liệu; các
 * hàm fetch gốc ở `lib/content-bank.ts` giữ nguyên vai trò lời gọi
 * API bên dưới các options.
 *
 * Cả hai bề mặt đều có máy trạng thái riêng dày (bộ lọc + không gian
 * đang mở + trạng thái bận theo từng dòng ở trang kho; toàn bộ trường
 * form ở màn tạo/sửa) nên trang đọc bằng `queryClient.fetchQuery(...)`
 * tại đúng các nhịp bản thủ công từng gọi fetch (nạp đầu, nạp lại sau
 * thao tác, nạp lười khi mở panel cắm vào khoá, đổi môn/khối) thay vì
 * đổi sang `useQuery` khai báo — cùng khuôn trang tin nhắn của đợt
 * F-01. Vì vậy hai route kho học liệu không gắn `clientLoader`:
 * prefetch ở loader không đổi được nhịp đọc do trang chủ động gọi.
 * Mọi options đặt `staleTime: 0`: mỗi nhịp đọc phải lấy số tươi từ
 * API đúng như bản thủ công (đặc biệt URL tải tệp đã ký có hạn dùng —
 * dùng lại bản cache có thể đưa URL đã hết hạn).
 */

/** Một danh mục câu hỏi cho bộ chọn tham chiếu của học liệu loại bộ câu hỏi (GET /questions/categories?contextId=). */
export interface QuestionCategoryView {
  id: string;
  name: string;
}

/** Một node chương trình đã phẳng hoá kèm YCCĐ của toàn bộ cây con (phục vụ bộ chọn node ở màn tạo/sửa). */
export interface FlatNode {
  id: string;
  title: string;
  kind: string;
  depth: number;
  outcomeIds: string[];
  outcomes: { id: string; content: string }[];
}

/** Phẳng hoá cây chương trình theo chiều sâu, gom YCCĐ của từng cây con vào chính node tổ tiên của nó. */
export function flattenNodes(nodes: CurriculumTreeNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
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

// ---------------------------------------------------------------------
// Đọc dữ liệu.
// ---------------------------------------------------------------------

/** Tuỳ chọn truy vấn các không gian kho học liệu (GET /contentbank/spaces). */
export function contentBankSpacesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.contentBankSpaces,
    queryFn: () => fetchSpaces(),
    staleTime: 0,
  });
}

/** Tuỳ chọn truy vấn toàn bộ học liệu thuộc các không gian người xem thấy (GET /contentbank, không lọc — trang tự lọc theo lựa chọn). */
export function contentBankItemsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.contentBankItems,
    queryFn: () => fetchItems(),
    staleTime: 0,
  });
}

/** Tuỳ chọn truy vấn chi tiết một học liệu (GET /contentbank/:id) cho màn sửa. */
export function contentBankItemQueryOptions(itemId: string) {
  return queryOptions({
    queryKey: queryKeys.contentBankItem(itemId),
    queryFn: () => fetchItem(itemId),
    staleTime: 0,
  });
}

/** Tuỳ chọn truy vấn URL tải tệp đã ký của một học liệu (GET /contentbank/:id/file-url); luôn đọc tươi vì URL có hạn dùng. */
export function contentBankItemFileUrlQueryOptions(itemId: string) {
  return queryOptions({
    queryKey: queryKeys.contentBankItemFileUrl(itemId),
    queryFn: () => fetchItemFileUrl(itemId),
    staleTime: 0,
  });
}

/**
 * Tuỳ chọn truy vấn môn học cho bộ lọc của kho học liệu: chuỗi hai
 * bước như bản thủ công — tìm context hệ thống trong GET
 * /access/contexts rồi đọc môn của context đó; mọi lỗi trên chuỗi
 * đều nuốt thành danh sách rỗng (trang chỉ mất gợi ý tên môn, không
 * sập).
 */
export function contentBankSubjectsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.contentBankSubjects,
    queryFn: async () => {
      const systemContextId = await fetchSystemContextId().catch(() => null);
      if (!systemContextId) return [] as CurriculumSubject[];
      return fetchSubjects(systemContextId).catch(() => [] as CurriculumSubject[]);
    },
    staleTime: 0,
  });
}

/**
 * Tuỳ chọn truy vấn danh mục câu hỏi trong context hệ thống (màn
 * tạo/sửa học liệu loại bộ câu hỏi chọn category để tham chiếu):
 * cùng chuỗi tìm context hệ thống như options môn học; lỗi thì rỗng.
 */
export function contentBankQuestionCategoriesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.contentBankQuestionCategories,
    queryFn: async () => {
      const systemContextId = await fetchSystemContextId().catch(() => null);
      if (!systemContextId) return [] as QuestionCategoryView[];
      return apiJson<QuestionCategoryView[]>(`/api/v1/questions/categories?contextId=${systemContextId}`)
        .catch(() => [] as QuestionCategoryView[]);
    },
    staleTime: 0,
  });
}

/**
 * Tuỳ chọn truy vấn node chương trình đã phẳng hoá theo môn + khối:
 * đọc các chương trình của môn, chọn chương trình đúng khối rồi
 * phẳng hoá cây của nó; không có chương trình khớp hoặc lỗi đọc cây
 * thì rỗng — đúng nhịp nạp cây của bản thủ công ở màn tạo/sửa.
 */
export function contentBankCurriculumNodesQueryOptions(subjectId: string, grade: number) {
  return queryOptions({
    queryKey: queryKeys.contentBankCurriculumNodes(subjectId, grade),
    queryFn: async () => {
      const curricula = await fetchCurricula(subjectId).catch(() => []);
      const curriculum = curricula.find((c) => c.grade === grade);
      if (!curriculum) return [] as FlatNode[];
      const tree = await fetchTree(curriculum.id).catch(() => null);
      return tree ? flattenNodes(tree.nodes) : [];
    },
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------
// Đột biến. Mọi đột biến đổi dữ liệu kho đều invalidate cụm khoá danh
// sách học liệu (và khoá chi tiết của chính học liệu khi liên quan)
// để mọi bề mặt đang giữ cache đọc lại số tươi; trang kho vẫn nạp lại
// ngay bằng fetchQuery sau thao tác như bản thủ công.
// ---------------------------------------------------------------------

/** Đột biến gửi duyệt một học liệu (POST /contentbank/:id/submit). */
export function useSubmitContentBankItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => submitItem(itemId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
    },
  });
}

/** Đột biến xoá một học liệu (DELETE /contentbank/:id). */
export function useDeleteContentBankItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => deleteItem(itemId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
    },
  });
}

/** Đột biến duyệt/từ chối một học liệu đang chờ (POST /contentbank/:id/review kèm ghi chú + checklist). */
export function useReviewContentBankItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, decision, note, checklist }: {
      itemId: string;
      decision: 'approved' | 'rejected';
      note?: string;
      checklist?: ReviewChecklist;
    }) => reviewItem(itemId, decision, note, checklist),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
    },
  });
}

/**
 * Đột biến cắm một học liệu vào một section của khoá bằng bản sao
 * (POST /contentbank/:id/insert): thao tác này tạo nội dung phía
 * khoá, không đổi dữ liệu kho học liệu nên không invalidate cụm khoá
 * kho — trang chỉ cần mã module vừa cắm để báo thành công.
 */
export function useInsertContentBankItem() {
  return useMutation({
    mutationFn: ({ itemId, courseId, sectionId }: { itemId: string; courseId: string; sectionId: string }) =>
      insertItem(itemId, courseId, sectionId),
  });
}

/** Đột biến tạo một học liệu mới (POST /contentbank). */
export function useCreateContentBankItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LibraryItemInput) => createItem(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
    },
  });
}

/** Đột biến sửa một học liệu (PATCH /contentbank/:id). */
export function useUpdateContentBankItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, input }: { itemId: string; input: Partial<LibraryItemInput> }) => updateItem(itemId, input),
    onSuccess: (_data, { itemId }) => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItem(itemId) });
    },
  });
}

/** Đột biến tải tệp lên cho một học liệu vừa lưu (POST /contentbank/:id/file, base64). */
export function useUploadContentBankItemFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, fileName, contentBase64, mimeType }: {
      itemId: string;
      fileName: string;
      contentBase64: string;
      mimeType?: string;
    }) => uploadItemFile(itemId, fileName, contentBase64, mimeType),
    onSuccess: (_data, { itemId }) => {
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItems });
      void client.invalidateQueries({ queryKey: queryKeys.contentBankItem(itemId) });
    },
  });
}
