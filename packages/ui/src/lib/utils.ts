import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Gộp danh sách class Tailwind thành một chuỗi duy nhất: `clsx` xử lý
 * điều kiện/mảng, `tailwind-merge` khử các class xung đột nhau (class
 * đứng sau thắng). Đây là cài đặt `cn` chuẩn của shadcn/ui, khai báo
 * thẳng trong package này thay vì dựa vào một package npm bên ngoài.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
