import { createContext, useContext } from 'react';

/**
 * Trạng thái thu/mở sidebar KHỞI TẠO, do root route cung cấp xuống
 * (F-11 của rà soát #133, việc #146): root loader đọc cookie
 * `sidebar_state` từ request phía server, App đưa giá trị xuống qua
 * context này, nên HTML SSR và lần render hydrate đầu dùng đúng một
 * giá trị. Trước đây shell tự đọc `document.cookie` trong initializer
 * phía client trong khi phía server luôn mặc định mở → khi cookie là
 * `false`, hydrate đầu lệch với HTML SSR và bề ngang nhảy một nhịp.
 */
export const SidebarDefaultOpenContext = createContext<boolean>(true);

export function useSidebarDefaultOpen(): boolean {
  return useContext(SidebarDefaultOpenContext);
}
