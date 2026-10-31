/**
 * Điểm vào CLI của pipeline cấp phát trung tâm mới (issue #583) —
 * chạy ngoài NestJS như các công cụ fleet (`node
 * dist/space-provision.js <lệnh> [--khóa giá-trị]`).
 *
 * Hai lệnh:
 * - `provision`: chạy toàn bộ pipeline 7 bước (xem
 *   `space-provision-runner.ts`); bắt buộc `--slug`, `--name`,
 *   `--admin-email`, `--actor-id` (UUID tài khoản quản trị vận hành
 *   — ghi vào lịch sử sổ đăng ký, không có giá trị mặc định).
 * - `invite`: cấp lại lời mời kích hoạt cho một tài khoản của trung
 *   tâm (huỷ lời mời đang chờ rồi tạo mới); bắt buộc `--slug`,
 *   `--email`; `--revoke` thì chỉ huỷ, không tạo mới.
 *
 * Đầu ra: các dòng tiến trình + một dòng JSON cuối cùng
 * (`PROVISION_RESULT` / `INVITE_RESULT`) để vận hành đọc bằng mắt
 * hoặc dùng script bắt tiếp. Mật khẩu database mới sinh và token
 * lời mời chỉ xuất hiện ở đầu ra này, đúng một lần — không ghi
 * xuống đĩa, không ghi vào sổ đăng ký, không ghi log nơi khác.
 * Sau `provision`, vận hành còn phải thêm biến môi trường
 * `SPACE_<SLUG>_DATABASE_URL` vào môi trường triển khai thì tầng
 * ứng dụng mới phân giải được trung tâm mới (in rõ ở cuối đầu ra).
 */
import { manageCentreInvite, runSpaceProvision } from './space-provision-runner';

/** Phân tích tham số dạng `--khóa giá-trị` / `--cờ` từ argv. */
function parseArgs(argv: string[]): Record<string, string | true> {
  const args: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg} (expected --key value)`);
    const key = arg.slice(2);
    if (!key) throw new Error('Empty -- flag');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

/** Lấy tham số bắt buộc dạng chuỗi, lỗi rõ khi thiếu. */
function required(args: Record<string, string | true>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing required --${key}`);
  return value;
}

/** Lấy tham số tuỳ chọn dạng chuỗi. */
function optional(args: Record<string, string | true>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

const USAGE = `Usage:
  node dist/space-provision.js provision --slug <slug> --name <name> --admin-email <email> --actor-id <uuid> [--plan <plan>] [--admin-username <username>] [--admin-first-name <name>] [--admin-last-name <name>] [--database-name <db>] [--database-password <password>]
  node dist/space-provision.js invite --slug <slug> --email <email> [--revoke]`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'provision') {
    const result = await runSpaceProvision({
      slug: required(args, 'slug'),
      name: required(args, 'name'),
      plan: optional(args, 'plan'),
      adminUsername: optional(args, 'admin-username'),
      adminEmail: required(args, 'admin-email'),
      adminFirstName: optional(args, 'admin-first-name'),
      adminLastName: optional(args, 'admin-last-name'),
      databaseName: optional(args, 'database-name'),
      databasePassword: optional(args, 'database-password'),
      actorId: required(args, 'actor-id'),
    });
    console.log(`PROVISION_RESULT ${JSON.stringify({
      slug: result.slug,
      spaceId: result.spaceId,
      databaseName: result.databaseName,
      connectionRole: result.connectionRole,
      secretEnvVar: result.secretEnvVar,
      tenantId: result.tenantId,
      adminUserId: result.adminUserId,
      inviteToken: result.inviteToken,
      inviteExpiresAt: result.inviteExpiresAt?.toISOString() ?? null,
      passwordWasGenerated: result.passwordWasGenerated,
      generatedPassword: result.generatedPassword,
      status: result.status,
      steps: result.steps,
    })}`);
    if (result.status === 'active') {
      console.log(`Next operator step (NOT automated): add ${result.secretEnvVar} (the centre database URL) to the deployment environment, otherwise the app tier cannot resolve this centre.`);
      if (result.passwordWasGenerated) {
        console.log('Save the generated database password above immediately — it is printed only once and stored nowhere.');
      }
      if (result.inviteToken) {
        console.log(`Send the invite token above to the first admin (${required(args, 'admin-email')}) to set their password via POST /api/v1/centres/activate-invite with { slug, token, password }.`);
      } else {
        console.log('A pending invite already exists for the first admin — if its link was lost, re-issue with: node dist/space-provision.js invite --slug <slug> --email <email>');
      }
    }
    return;
  }
  if (command === 'invite') {
    const result = await manageCentreInvite({
      slug: required(args, 'slug'),
      email: required(args, 'email'),
      revokeOnly: args['revoke'] === true,
    });
    console.log(`INVITE_RESULT ${JSON.stringify({
      slug: result.slug,
      userId: result.userId,
      revokedCount: result.revokedCount,
      inviteToken: result.inviteToken,
      inviteExpiresAt: result.inviteExpiresAt?.toISOString() ?? null,
    })}`);
    if (result.inviteToken) {
      console.log(`Send the invite token above to ${required(args, 'email')} to set their password via POST /api/v1/centres/activate-invite with { slug, token, password }.`);
    }
    return;
  }
  console.error(USAGE);
  throw new Error(`Unknown command ${command ?? '(none)'}`);
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
