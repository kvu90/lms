import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpActor } from './mcp.context';
import { registerMcpTools, type McpToolDeps } from './mcp.tools';

/**
 * Factory dựng McpServer cho MỘT request (SDK v2 stateless: mỗi request
 * một instance — xem createMcpHandler). Tools đăng ký ở mcp.tools.ts,
 * phục vụ cả hai kỷ nguyên (modern 2026-07-28 + legacy 2025-11-25) qua
 * cùng factory này.
 *
 * Ngoài tools, lát MCP-1 (issue #163) thêm một resource hướng dẫn +
 * một prompt mẫu để client AI đi đúng quy trình nghiệp vụ (bám YCCĐ
 * thật, soi trùng trước khi tạo, câu mới luôn vào draft chờ giáo viên
 * duyệt) thay vì bịa quy trình riêng.
 */
export function createLmsMcpServer(actor: McpActor, deps: McpToolDeps): McpServer {
  const server = new McpServer(
    { name: 'lms-mcp', version: '0.2.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  registerMcpTools(server, actor, deps);
  registerMcpResources(server);
  registerMcpPrompts(server);
  return server;
}

const QUESTION_AUTHORING_GUIDE = `# Soạn câu hỏi cho LMS — quy trình bắt buộc

Bạn đang soạn câu hỏi cho ngân hàng câu hỏi của giáo viên đang đăng nhập. Mọi câu bạn tạo đều vào trạng thái DRAFT (bản nháp) và chỉ dùng được sau khi giáo viên duyệt phát hành. Tuân thủ đúng thứ tự:

1. **Bám yêu cầu cần đạt (YCCĐ) thật.** Gọi \`search_curriculum_outcomes\` với từ khoá của bài/chủ đề để lấy YCCĐ chính thức của chương trình. Chỉ soạn câu bám vào YCCĐ đã trả về — TUYỆT ĐỐI không tự bịa mã hay nội dung YCCĐ. Liên kết câu × YCCĐ chính thức được ghi ở tầng ma trận đề/quiz phía giáo viên, không phải ở bước này.
2. **Tìm đích ghi.** Gọi \`list_my_banks\` rồi \`list_categories\` để lấy bankId (bank CÁ NHÂN của giáo viên) và categoryId thuộc bank đó. Tool ghi chỉ chấp nhận bank cá nhân của chính giáo viên.
3. **Soi trùng trước.** Gọi \`search_questions\` để xem câu tương tự đã có chưa, và \`check_duplicates\` cho các câu sắp tạo. Câu trùng hoàn toàn (exact) sẽ bị hệ thống bỏ qua khi tạo — hãy sửa nội dung hoặc bỏ câu đó.
4. **Tạo câu.** Một câu: \`create_question\`. Nhiều câu: \`create_questions_batch\` (kết quả từng câu; mỗi câu phải có \`clientItemId\` riêng). Nhóm câu cùng một ngữ liệu (đoạn văn/bài đọc): \`create_stimulus_with_questions\` (nguyên tử — một câu lỗi là cả nhóm không được tạo), hoặc khai \`stimuli\` + \`stimulusRef\` trong batch. Luôn đặt \`idempotencyKey\` mới cho mỗi lượt tạo khác nhau; phát lại cùng key + cùng payload là an toàn.
5. **Định dạng đáp án.** multichoice: tối thiểu 2 đáp án, tổng fraction của các đáp án đúng = 1. truefalse: đúng hai đáp án "True"/"False" với fraction 1 và 0. shortanswer: các đáp án chấp nhận được, fraction 1 cho đáp án đúng hoàn toàn. essay: không có đáp án. Nội dung là văn bản thuần — không HTML, không ký tự điều khiển.
6. **Phát hành.** Chỉ khi giáo viên yêu cầu rõ, gọi \`publish_questions\` để chuyển draft → ready (cần scope \`lms.questions.write\`). Mặc định KHÔNG tự phát hành.
7. **Đóng góp lên bank chung.** Giáo viên muốn đưa câu đã ready lên bank tổ/trường thì dùng \`submit_contribution\` — đề xuất ở trạng thái chờ duyệt, người điều hành bank chung quyết định, bạn không ghi thẳng được vào bank chung.
`;

function registerMcpResources(server: McpServer): void {
  server.registerResource(
    'question-authoring-guide',
    'lms://guide/question-authoring',
    {
      title: 'Hướng dẫn soạn câu hỏi bám YCCĐ',
      description:
        'Quy trình soạn câu hỏi chuẩn của LMS: bám YCCĐ thật qua search_curriculum_outcomes, soi trùng trước khi tạo, câu mới vào draft, phát hành chỉ khi giáo viên yêu cầu.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        { uri: 'lms://guide/question-authoring', mimeType: 'text/markdown', text: QUESTION_AUTHORING_GUIDE },
      ],
    }),
  );
}

function registerMcpPrompts(server: McpServer): void {
  server.registerPrompt(
    'tao_cau_hoi_theo_yccd',
    {
      title: 'Tạo câu hỏi theo yêu cầu cần đạt',
      description:
        'Soạn một bộ câu hỏi draft bám đúng một yêu cầu cần đạt (YCCĐ) lấy từ search_curriculum_outcomes, qua đúng quy trình của resource lms://guide/question-authoring.',
      argsSchema: {
        outcomeContent: z.string().describe('Nguyên văn nội dung YCCĐ (lấy từ kết quả search_curriculum_outcomes)'),
        outcomeId: z.string().optional().describe('Id của YCCĐ trong hệ thống (truy vết)'),
        subjectName: z.string().optional().describe('Tên môn học của YCCĐ'),
        grade: z.string().optional().describe('Khối lớp của YCCĐ'),
        qtype: z
          .enum(['multichoice', 'truefalse', 'shortanswer', 'essay'])
          .optional()
          .describe('Dạng câu hỏi muốn tạo (mặc định multichoice)'),
        count: z.string().optional().describe('Số câu cần tạo (mặc định 5)'),
      },
    },
    async (args) => {
      const count = args.count ?? '5';
      const qtype = args.qtype ?? 'multichoice';
      const contextLine = [
        args.subjectName ? `Môn: ${args.subjectName}` : null,
        args.grade ? `Khối: ${args.grade}` : null,
        args.outcomeId ? `Mã YCCĐ trong hệ thống: ${args.outcomeId}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Hãy soạn ${count} câu hỏi dạng ${qtype} bám đúng yêu cầu cần đạt sau đây${contextLine ? ` (${contextLine})` : ''}:\n\n` +
                `"${args.outcomeContent}"\n\n` +
                'Thực hiện đúng quy trình trong resource lms://guide/question-authoring: ' +
                'xác nhận lại YCCĐ bằng search_curriculum_outcomes nếu cần, lấy bankId/categoryId từ list_my_banks + list_categories, ' +
                'soi trùng bằng check_duplicates, rồi tạo câu ở trạng thái draft bằng create_questions_batch (mỗi câu một clientItemId). ' +
                'Mọi câu phải kiểm tra được đúng nội dung của YCCĐ trên, đáp án đúng phải chắc chắn, các đáp án nhiễu phải hợp lý. ' +
                'KHÔNG tự phát hành (publish) — để giáo viên duyệt.',
            },
          },
        ],
      };
    },
  );
}
