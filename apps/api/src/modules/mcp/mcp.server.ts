import { McpServer } from '@modelcontextprotocol/server';
import type { McpActor } from './mcp.context';
import { registerMcpTools, type McpToolDeps } from './mcp.tools';

/**
 * Factory dựng McpServer cho MỘT request (SDK v2 stateless: mỗi request
 * một instance — xem createMcpHandler). Tools đăng ký ở mcp.tools.ts,
 * phục vụ cả hai kỷ nguyên (modern 2026-07-28 + legacy 2025-11-25) qua
 * cùng factory này.
 */
export function createLmsMcpServer(actor: McpActor, deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: 'lms-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  registerMcpTools(server, actor, deps);
  return server;
}
