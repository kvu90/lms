// Cấu hình Prettier của @lms/web. Mục đích hiện tại của Prettier ở
// đây là sắp xếp class Tailwind bằng plugin CHÍNH THỨC của
// Tailwind Labs (prettier-plugin-tailwindcss) — các tuỳ chọn định
// dạng còn lại bám theo phong cách đang có của mã nguồn app (dấu
// nháy đơn, chấm phẩy, độ rộng 120) để việc sắp xếp không kéo theo
// thay đổi định dạng ngoài ý muốn. Plugin cần đường dẫn tới file
// CSS chứa @theme của design system (nay nằm ở package @lms/ui).
export default {
  semi: true,
  singleQuote: true,
  printWidth: 120,
  trailingComma: 'all',
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: '../../packages/ui/src/styles/globals.css',
  tailwindFunctions: ['cn'],
};
