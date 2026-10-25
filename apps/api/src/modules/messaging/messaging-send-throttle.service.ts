import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { redisTlsFromUrl } from '../../config/env';
import { SiteConfigService } from '../site-config/site-config.service';

const BURST_KEY_PREFIX = 'lms:messaging:send-burst:';
const MINUTE_KEY_PREFIX = 'lms:messaging:send-minute:';
/** Cửa sổ duy trì luôn là 60 giây (trần đọc từ site-config là số tin/phút). */
const MINUTE_WINDOW_SECONDS = 60;

/**
 * Script Lua kiểm-tra-rồi-tăng NGUYÊN TỬ cho cả hai cửa sổ: lần gửi bị
 * từ chối KHÔNG bị tính vào bộ đếm (nếu tính, người dùng càng thử lại
 * càng tự kéo dài thời gian bị chặn và khẳng định "hồi sau cửa sổ" của
 * spec không còn đúng theo đồng hồ cửa sổ). Trả [1, ''] khi được gửi,
 * [0, 'burst'|'minute'] khi chạm trần của cửa sổ tương ứng. Trần <= 0
 * nghĩa là cửa sổ đó TẮT (theo quy ước 0 = tắt của các setting nhắn
 * tin, xem messagingrecallwindowminutes).
 */
const CONSUME_SCRIPT = `
local burstCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local minuteCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local burstLimit = tonumber(ARGV[1])
local minuteLimit = tonumber(ARGV[2])
if burstLimit > 0 and burstCount >= burstLimit then return {0, 'burst'} end
if minuteLimit > 0 and minuteCount >= minuteLimit then return {0, 'minute'} end
if burstLimit > 0 then
  local n = redis.call('INCR', KEYS[1])
  if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
end
if minuteLimit > 0 then
  local n = redis.call('INCR', KEYS[2])
  if n == 1 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
end
return {1, ''}
`;

/**
 * Throttle gửi tin theo TỪNG NGƯỜI DÙNG bằng Redis (lát M2, issue
 * #212; hồ sơ rà soát hoàn thiện nhắn tin mục M2). Hai cửa sổ cố định
 * chạy song song, mức đọc qua site-config ở MỖI lần gửi nên quản trị
 * đổi cấu hình là hành vi đổi ngay, không cần khởi động lại:
 *   - bùng phát: `core/messagingsendburstlimit` tin trong
 *     `core/messagingsendburstwindowseconds` giây (mặc định 20/10s);
 *   - duy trì: `core/messagingsendperminutelimit` tin/phút (mặc định
 *     60, tức ~1 tin/giây).
 * Chạm một trong hai trần → 429 `messaging.rate_limited`. Khoá đếm
 * theo userId (định danh toàn cục duy nhất) nên không lẫn giữa các
 * tenant và tự hết hạn theo TTL — không có dữ liệu bền nào phải dọn.
 *
 * Redis là hạ tầng phụ trợ của đường gửi (cùng họ presence/typing):
 * Redis lỗi thì FAIL-OPEN kèm log cảnh báo — thà mất lớp chống lạm
 * dụng trong chốc lát còn hơn chặn đứng toàn bộ nhắn tin, đúng triết
 * lý "đường phụ không được làm hỏng nghiệp vụ" của tầng realtime.
 */
@Injectable()
export class MessagingSendThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(MessagingSendThrottleService.name);
  private readonly redisUrl: string;
  private client: Redis | null = null;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly siteConfig: SiteConfigService,
  ) {
    this.redisUrl = config.getOrThrow<string>('REDIS_URL');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => undefined);
    this.client = null;
  }

  /** Connection Redis riêng của throttle (tách khỏi cặp adapter và client presence/typing). */
  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis(this.redisUrl, {
        maxRetriesPerRequest: null,
        ...redisTlsFromUrl(this.redisUrl),
      });
      this.client.on('error', (error: Error) => {
        this.logger.warn(`Redis của throttle gửi tin lỗi: ${error.message}`);
      });
    }
    return this.client;
  }

  /**
   * Tiêu thụ một lượt gửi của `userId`: qua được thì trả về lặng lẽ,
   * chạm trần thì ném 429 `messaging.rate_limited`. Người gọi phải gọi
   * SAU khi đã kiểm tra tư cách/cổng liên lạc và SAU điểm trả trùng
   * `clientMessageId` — lượt gửi lại của một tin đã nhận không tốn
   * quota, và tin bị từ chối ở các cổng trước cũng vậy.
   */
  async consume(userId: string): Promise<void> {
    const [burstLimit, burstWindowSeconds, perMinuteLimit] = await Promise.all([
      this.siteConfig.getValue<number>('core', 'messagingsendburstlimit'),
      this.siteConfig.getValue<number>('core', 'messagingsendburstwindowseconds'),
      this.siteConfig.getValue<number>('core', 'messagingsendperminutelimit'),
    ]);
    const burst = Math.floor(burstLimit ?? 0);
    const windowSeconds = Math.max(1, Math.floor(burstWindowSeconds ?? 0));
    const perMinute = Math.floor(perMinuteLimit ?? 0);
    if (burst <= 0 && perMinute <= 0) return;
    let result: unknown;
    try {
      result = await this.redis().eval(
        CONSUME_SCRIPT,
        2,
        `${BURST_KEY_PREFIX}${userId}`,
        `${MINUTE_KEY_PREFIX}${userId}`,
        String(burst),
        String(perMinute),
        String(windowSeconds),
        String(MINUTE_WINDOW_SECONDS),
      );
    } catch (error) {
      this.logger.warn(`Throttle gửi tin không kiểm tra được cho user ${userId} (fail-open): ${(error as Error).message}`);
      return;
    }
    const [allowed, window] = result as [number, string];
    if (allowed !== 1) {
      throw new HttpException(
        {
          message: window === 'burst'
            ? 'You are sending messages too quickly; wait a few seconds and try again'
            : 'You have reached the message sending limit for now; wait a moment and try again',
          code: 'messaging.rate_limited',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
