import { describe, expect, it } from 'vitest';
import {
  cacheRedisConfigFromUrl,
  databaseConnectionFromEnv,
  redisConnectionFromUrl,
  redisTlsFromUrl,
  validateEnv,
} from './env';

describe('Hàm validateEnv (fail-fast)', () => {
  it('chấp nhận env hợp lệ', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-with-16+chars',
    });
    expect(env.PORT).toBe(3000);
  });

  it('từ chối khi thiếu DATABASE_URL', () => {
    expect(() =>
      validateEnv({ REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'a-secret-with-16+chars' }),
    ).toThrow(/Invalid environment variables/);
  });

  it('mặc định DATABASE_SSL là false và phân tích cờ true', () => {
    const base = {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-with-16+chars',
    };
    expect(validateEnv(base).DATABASE_SSL).toBe(false);
    expect(validateEnv({ ...base, DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(true);
  });

  it('từ chối giá trị DATABASE_SSL không hợp lệ', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'a-secret-with-16+chars',
        DATABASE_SSL: 'yes',
      }),
    ).toThrow(/Invalid environment variables/);
  });

  it('từ chối JWT_SECRET quá ngắn', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'short',
      }),
    ).toThrow(/Invalid environment variables/);
  });
});

describe('Hàm databaseConnectionFromEnv', () => {
  it('trả URL thuần khi SSL tắt', () => {
    expect(databaseConnectionFromEnv('postgres://localhost/lms', false)).toBe(
      'postgres://localhost/lms',
    );
  });

  it('trả PoolConfig có SSL khi cờ đang bật', () => {
    expect(databaseConnectionFromEnv('postgres://db.example.com/lms', true)).toEqual({
      connectionString: 'postgres://db.example.com/lms',
      ssl: { rejectUnauthorized: false },
    });
  });
});

describe('Hàm redisConnectionFromUrl', () => {
  it('phân tích URL redis:// thuần không có TLS', () => {
    const conn = redisConnectionFromUrl('redis://localhost:6379');
    expect(conn.host).toBe('localhost');
    expect(conn.port).toBe(6379);
    expect(conn.tls).toBeUndefined();
  });

  it('bật TLS cho URL rediss://', () => {
    const conn = redisConnectionFromUrl('rediss://user:pass@redis.example.com:6380');
    expect(conn.host).toBe('redis.example.com');
    expect(conn.port).toBe(6380);
    expect(conn.tls).toEqual({ rejectUnauthorized: false });
  });
});

describe('Hàm redisTlsFromUrl', () => {
  it('không trả tuỳ chọn TLS nào cho URL redis:// thuần', () => {
    expect(redisTlsFromUrl('redis://localhost:6379')).toEqual({});
  });

  it('tắt xác minh chứng chỉ cho URL rediss://', () => {
    expect(redisTlsFromUrl('rediss://redis.example.com:6380')).toEqual({
      tls: { rejectUnauthorized: false },
    });
  });
});

describe('Hàm cacheRedisConfigFromUrl', () => {
  it('cho URL redis:// thuần đi qua nguyên vẹn', () => {
    expect(cacheRedisConfigFromUrl('redis://localhost:6379')).toEqual({
      url: 'redis://localhost:6379',
    });
  });

  it('thêm socket TLS không xác minh cho URL rediss://', () => {
    expect(cacheRedisConfigFromUrl('rediss://redis.example.com:6380')).toEqual({
      url: 'rediss://redis.example.com:6380',
      socket: { tls: true, rejectUnauthorized: false },
    });
  });
});
