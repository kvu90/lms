import { describe, expect, it } from 'vitest';
import {
  cacheRedisConfigFromUrl,
  databaseConnectionFromEnv,
  redisConnectionFromUrl,
  redisTlsFromUrl,
  validateEnv,
} from './env';

describe('validateEnv (fail-fast)', () => {
  it('accepts a valid env', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-with-16+chars',
    });
    expect(env.PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() =>
      validateEnv({ REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'a-secret-with-16+chars' }),
    ).toThrow(/Invalid environment variables/);
  });

  it('defaults DATABASE_SSL to false and parses the true flag', () => {
    const base = {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'a-secret-with-16+chars',
    };
    expect(validateEnv(base).DATABASE_SSL).toBe(false);
    expect(validateEnv({ ...base, DATABASE_SSL: 'true' }).DATABASE_SSL).toBe(true);
  });

  it('rejects an invalid DATABASE_SSL value', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/lms',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'a-secret-with-16+chars',
        DATABASE_SSL: 'yes',
      }),
    ).toThrow(/Invalid environment variables/);
  });

  it('rejects a too-short JWT_SECRET', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'short',
      }),
    ).toThrow(/Invalid environment variables/);
  });
});

describe('databaseConnectionFromEnv', () => {
  it('returns the plain URL when SSL is off', () => {
    expect(databaseConnectionFromEnv('postgres://localhost/lms', false)).toBe(
      'postgres://localhost/lms',
    );
  });

  it('returns a PoolConfig with SSL when the flag is on', () => {
    expect(databaseConnectionFromEnv('postgres://db.example.com/lms', true)).toEqual({
      connectionString: 'postgres://db.example.com/lms',
      ssl: { rejectUnauthorized: false },
    });
  });
});

describe('redisConnectionFromUrl', () => {
  it('parses a plain redis:// URL without TLS', () => {
    const conn = redisConnectionFromUrl('redis://localhost:6379');
    expect(conn.host).toBe('localhost');
    expect(conn.port).toBe(6379);
    expect(conn.tls).toBeUndefined();
  });

  it('enables TLS for a rediss:// URL', () => {
    const conn = redisConnectionFromUrl('rediss://user:pass@redis.example.com:6380');
    expect(conn.host).toBe('redis.example.com');
    expect(conn.port).toBe(6380);
    expect(conn.tls).toEqual({ rejectUnauthorized: false });
  });
});

describe('redisTlsFromUrl', () => {
  it('returns no TLS options for a plain redis:// URL', () => {
    expect(redisTlsFromUrl('redis://localhost:6379')).toEqual({});
  });

  it('disables certificate verification for a rediss:// URL', () => {
    expect(redisTlsFromUrl('rediss://redis.example.com:6380')).toEqual({
      tls: { rejectUnauthorized: false },
    });
  });
});

describe('cacheRedisConfigFromUrl', () => {
  it('passes a plain redis:// URL through untouched', () => {
    expect(cacheRedisConfigFromUrl('redis://localhost:6379')).toEqual({
      url: 'redis://localhost:6379',
    });
  });

  it('adds an unverified TLS socket for a rediss:// URL', () => {
    expect(cacheRedisConfigFromUrl('rediss://redis.example.com:6380')).toEqual({
      url: 'rediss://redis.example.com:6380',
      socket: { tls: true, rejectUnauthorized: false },
    });
  });
});
