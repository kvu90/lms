/**
 * Dựng bộ header cho request mà prod-server.mjs chuyển về API nội bộ
 * (đường proxy HTTP của topology C).
 *
 * Flow: request của trình duyệt tới mặt tiền công khai → prod-server
 * nhận diện đường proxy (xem proxy-paths.mjs) → bộ header dựng ở đây
 * được gắn lên request phía API (node:http) → API xử lý theo đúng
 * địa chỉ công khai mà trình duyệt đã gọi.
 *
 * Bất biến địa chỉ: header `Host` của request gốc là địa chỉ công
 * khai duy nhất mà tầng ứng dụng dùng để phân giải trung tâm theo
 * tên miền con (issue #582: nhãn đầu tiên của Host là slug của
 * trung tâm trong sổ đăng ký). Đích TCP của request phía API do
 * hostname/port của origin nội bộ quyết định (tham số của
 * httpRequest), KHÔNG do header Host quyết — nên giữ nguyên Host
 * gốc không làm lệch đích kết nối, còn ghi đè Host bằng origin nội
 * bộ thì địa chỉ trung tâm biến mất lặng lẽ trước khi tới API: mọi
 * phân giải theo địa chỉ ở API (guard gắn ngữ cảnh, handler đăng
 * nhập Better Auth, socket auth) đều rơi về đường mặc định.
 *
 * Hai header chuyển tiếp còn lại giữ đúng hành vi hiện hành:
 * X-Forwarded-For nối tiếp chuỗi của các chặng trước rồi thêm IP
 * của chặng này; X-Forwarded-Proto chỉ đặt mặc định `http` khi
 * request chưa mang (chặng tunnel ở biên đã mang thì giữ nguyên).
 */

/** Chuỗi X-Forwarded-For: giữ nguyên các chặng trước rồi nối IP của chặng proxy này. */
function forwardedFor(prior, remoteAddress) {
  const clientIp = remoteAddress ?? '';
  return prior ? `${prior}, ${clientIp}` : clientIp;
}

/**
 * Dựng header cho request phía API từ header của request gốc.
 *
 * @param incomingHeaders - Header của request gốc (req.headers của node:http, khoá chữ thường).
 * @param remoteAddress - IP của chặng kết nối tới prod-server (req.socket.remoteAddress).
 * @param apiHost - Host của origin API nội bộ (apiOrigin.host) — chỉ còn là giá trị dự phòng khi request gốc không mang Host.
 * @returns Bộ header gắn lên request phía API: Host giữ nguyên của request gốc, X-Forwarded-For đã nối chặng, X-Forwarded-Proto đã có giá trị.
 */
export function buildProxyHeaders(incomingHeaders, remoteAddress, apiHost) {
  const headers = {
    ...incomingHeaders,
    // Host giữ nguyên của request gốc (xem bất biến địa chỉ ở đầu
    // file): chỉ khi request không mang Host mới rơi về origin nội
    // bộ như hành vi cũ cho các request không địa chỉ (health check
    // nội bộ...). TUYỆT ĐỐI không ghi đè Host đã có — đích kết nối
    // do hostname/port của httpRequest quyết, không do header này.
    host: incomingHeaders.host ?? apiHost,
    'x-forwarded-for': forwardedFor(incomingHeaders['x-forwarded-for'], remoteAddress),
  };
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  return headers;
}
