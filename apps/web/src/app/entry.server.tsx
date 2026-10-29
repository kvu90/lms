import { PassThrough } from 'node:stream';
import type { EntryContext } from 'react-router';
import { createReadableStreamFromReadable } from '@react-router/node';
import { ServerRouter } from 'react-router';
import { isbot } from 'isbot';
import type { RenderToPipeableStreamOptions } from 'react-dom/server';
import { renderToPipeableStream } from 'react-dom/server';

/**
 * Điểm vào phía server (SSR, Giai đoạn 3 của issue #7) — mẫu streaming
 * chính chủ của React Router framework mode: bot/crawler chờ render
 * toàn bộ (`onAllReady`) để nhận HTML đầy đủ, trình duyệt thường nhận
 * vỏ trang ngay khi khung sẵn sàng (`onShellReady`) rồi stream phần
 * còn lại. Hủy render khi quá `streamTimeout` để một route treo không
 * giữ kết nối vô hạn.
 */
export const streamTimeout = 5_000;

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: unknown,
) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get('user-agent');

    const readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? 'onAllReady' : 'onShellReady';

    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={routerContext} url={request.url} />, {
      [readyOption]() {
        shellRendered = true;
        const body = new PassThrough();
        const stream = createReadableStreamFromReadable(body);

        responseHeaders.set('Content-Type', 'text/html');

        resolve(
          new Response(stream, {
            headers: responseHeaders,
            status: responseStatusCode,
          }),
        );

        pipe(body);
      },

      onShellError(error: unknown) {
        reject(error);
      },

      onError(error: unknown) {
        responseStatusCode = 500;
        // Lỗi sau khi vỏ đã gửi thì chỉ ghi log — đáp ứng đang stream
        // không đổi được status nữa.
        if (shellRendered) {
          console.error(error);
        }
      },
    });

    setTimeout(abort, streamTimeout + 1000);
  });
}
