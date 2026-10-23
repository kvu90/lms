import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Khác bản shadcn gốc ở điểm khởi tạo: bản gốc để undefined rồi mới
  // set trong effect nên render đầu luôn theo desktop rồi đổi sang
  // mobile sau một nhịp (thêm một lần đổi khung trên máy nhỏ). Ở đây
  // tính đồng bộ ngay từ initializer — vẫn an toàn khi render phía
  // server/dựng sẵn (không có window thì mặc định desktop như cũ).
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.innerWidth < MOBILE_BREAKPOINT
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}
