import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../../support/identity-access-helpers';

/**
 * Hồi quy cho sự cố deploy của PR #28 (hotfix event-log date schema):
 * bootstrap production (main.ts) gọi `SwaggerModule.createDocument` sau
 * khi Nest khởi tạo xong — bước này chuyển mọi Standard Schema của route
 * sang JSON Schema. Một schema chứa kiểu `Date` (z.date/z.coerce.date)
 * làm bước chuyển đổi ném "Date cannot be represented in JSON Schema" và
 * tiến trình chết trước khi listen, trong khi các e2e thường (chỉ `app.init()`)
 * không bao giờ chạy bước này nên không bắt được. Spec này chạy đúng bước
 * bootstrap đó trên toàn bộ AppModule để mọi route tương lai thêm schema
 * không biểu diễn được đều đỏ tại CI thay vì tại production.
 */
describe('Sinh tài liệu OpenAPI (ngang bằng với bootstrap production)', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LMS API').setDescription('bootstrap parity probe').setVersion('1.0').build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('sinh tài liệu cho mọi route mà không ném lỗi', () => {
    expect(document).toBeDefined();
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
  });

  it('ghi tài liệu cho GET /event-logs với from/to là chuỗi ngày-giờ ISO', () => {
    const pathKey = Object.keys(document.paths ?? {}).find((p) => p.endsWith('/event-logs'));
    expect(pathKey, 'event-logs path must be present in the OpenAPI document').toBeDefined();
    const operation = document.paths[pathKey!]?.get;
    expect(operation).toBeDefined();
    const params = (operation?.parameters ?? []) as Array<{ name?: string; in?: string; schema?: { type?: string; format?: string } }>;
    for (const name of ['from', 'to']) {
      const param = params.find((p) => p.name === name && p.in === 'query');
      expect(param, `query param ${name} must be documented`).toBeDefined();
      expect(param?.schema?.type).toBe('string');
      expect(param?.schema?.format).toBe('date-time');
    }
  });
});
