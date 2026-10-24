import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpActor } from './mcp.context';

/**
 * Factory dựng McpServer cho MỘT request (SDK v2 stateless: mỗi request
 * một instance — xem createMcpHandler). Tools định nghĩa một lần ở đây,
 * phục vụ cả hai kỷ nguyên (modern 2026-07-28 + legacy 2025-11-25) qua
 * cùng factory. Mô tả tool viết cho model, tiếng Việt là chính (hồ sơ
 * research MCP Phần 1.6/2.3).
 */
export function createLmsMcpServer(actor: McpActor): McpServer {
  const server = new McpServer(
    { name: 'lms-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Tool spike của MCP-0: chứng minh endpoint sống ở cả hai kỷ nguyên
  // trước khi gắn tools thật (list_my_banks / list_categories /
  // create_question / get_question). Bị thay bằng tools thật trong
  // chính lát này — không nằm trong bề mặt nghiệm thu cuối.
  server.registerTool(
    'hello',
    {
      title: 'Lời chào kiểm tra kết nối (spike MCP-0)',
      description:
        'Tool kiểm tra kết nối tới MCP server của LMS: gọi thử để xác nhận client đã nối được, server trả lời kèm kỷ nguyên giao thức đang phục vụ. Không đọc/ghi dữ liệu học tập nào.',
      inputSchema: z.object({
        name: z.string().max(100).optional().describe('Tên muốn được chào (tuỳ chọn).'),
      }),
      outputSchema: z.object({
        message: z.string(),
        era: z.string(),
        actor: z.string(),
      }),
    },
    async ({ name }) => {
      const output = {
        message: `Xin chào ${name ?? actor.username} — bạn đã nối tới MCP server của LMS (MCP-0).`,
        era: actor.era,
        actor: actor.username,
      };
      return {
        content: [{ type: 'text', text: output.message }],
        structuredContent: output,
      };
    },
  );

  return server;
}
