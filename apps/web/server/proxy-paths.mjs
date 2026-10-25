/**
 * Bộ khớp đường proxy của SSR topology C (prod-server.mjs).
 *
 * Các đường thuộc về tiến trình API nội bộ, SSR chỉ chuyển tiếp:
 *   - `/api` và mọi subpath: REST API (`/api/v1/...`).
 *   - `/socket.io/...`: realtime (HTTP polling + đường hầm upgrade).
 *   - `/mcp` và mọi subpath: endpoint MCP của issue #110 (MCP-0 mount
 *     NGOÀI `/api/v1` theo thiết kế — Streamable HTTP stateless).
 *   - `/.well-known/oauth-protected-resource` và mọi subpath: metadata
 *     PRM (RFC 9728) của MCP, gồm cả biến thể
 *     `/.well-known/oauth-protected-resource/mcp`.
 *
 * Mọi đường còn lại thuộc về SSR/asset tĩnh. Khớp trên pathname (đã bỏ
 * query string): bản cũ khớp thẳng trên req.url nên ca `/mcp?...` sẽ
 * lọt exact-match; đồng thời exact + tiền tố có dấu `/` bảo đảm các
 * đường gần giống (`/mcpfoo`, `/apixyz`) KHÔNG bị proxy nuốt.
 */

const PROXY_EXACT = new Set(['/api', '/mcp', '/.well-known/oauth-protected-resource']);

const PROXY_PREFIXES = [
  '/api/',
  '/socket.io/',
  '/mcp/',
  '/.well-known/oauth-protected-resource/',
];

/** true nếu request (theo req.url thô, có thể kèm query) phải proxy về API. */
export function isProxyPath(url) {
  const path = url.split('?')[0];
  return PROXY_EXACT.has(path) || PROXY_PREFIXES.some((prefix) => path.startsWith(prefix));
}
