import { describe, expect, it } from 'vitest';
import { validateEnv } from './env';

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

  it('rejects a too-short JWT_SECRET', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'short',
      }),
    ).toThrow(/Invalid environment variables/);
  });
});
