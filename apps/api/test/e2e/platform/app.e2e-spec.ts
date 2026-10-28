import { Controller, Get, INestApplication, NotFoundException, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../src/app.module';
import { ProblemDetailsFilter } from '../../../src/common/problem-details.filter';
import { Public } from '../../../src/common/public.decorator';

@Public()
@Controller({ path: 'throw-probe', version: '1' })
class ThrowProbeController {
  @Get()
  boom(): never {
    throw new NotFoundException('probe resource missing');
  }
}

describe('API e2e (supertest, real DB + Redis)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns 200 with the contract shape', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toEqual({ database: 'up', redis: 'up' });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('errors are RFC 7807 application/problem+json', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/throw-probe');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'probe resource missing',
      code: 'http.not_found',
    });
  });

  it('unknown routes also produce Problem Details', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('http.not_found');
  });
});
