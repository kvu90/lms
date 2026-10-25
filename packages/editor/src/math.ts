import { renderToString } from 'katex';
import 'katex/contrib/mhchem';

/**
 * Điểm nối KaTeX duy nhất của package: mọi lần render công thức (panel
 * soạn, trình xem tĩnh, node view của extension) đều phải cho ra cùng một
 * cấu hình an toàn — `trust: false` để LaTeX của người soạn không chèn
 * được HTML tùy ý vào trang người học.
 *
 * Gói `mhchem` (contrib của KaTeX, cùng giấy phép MIT) được nạp ở đây để
 * công thức hoá học dùng được cú pháp `\ce{...}` — nạp một lần khi module
 * này được import, trước mọi lần render.
 */

/**
 * Render một công thức LaTeX thành HTML bằng KaTeX.
 *
 * Không ném lỗi khi LaTeX sai cú pháp (`throwOnError: false`): KaTeX tự
 * hiển thị phần lỗi bằng màu đỏ — một công thức hỏng không được làm sập
 * cả bề mặt hiển thị. Muốn chặn lưu khi sai cú pháp thì dùng
 * {@link validateMathLatex}.
 *
 * @param latex - Mã LaTeX của công thức.
 * @param displayMode - `true` cho công thức tách dòng (blockMath),
 *   `false` cho công thức trong dòng (inlineMath).
 * @returns Chuỗi HTML của công thức đã render.
 */
export function renderMathHtml(latex: string, displayMode: boolean): string {
  return renderToString(latex, { displayMode, throwOnError: false, trust: false });
}

/**
 * Kiểm tra một công thức LaTeX có hợp lệ để lưu hay không.
 *
 * Render thử với `throwOnError: true`: LaTeX sai cú pháp cho ra thông báo
 * lỗi để panel soạn hiển thị và chặn xác nhận; hợp lệ cho ra `null`.
 *
 * @param latex - Mã LaTeX cần kiểm tra.
 * @returns `null` nếu hợp lệ; ngược lại là thông báo lỗi cho người soạn.
 */
export function validateMathLatex(latex: string): string | null {
  if (!latex.trim()) {
    return 'Chưa nhập công thức.';
  }
  try {
    renderToString(latex, { displayMode: false, throwOnError: true, trust: false });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Công thức LaTeX không hợp lệ.';
  }
}
