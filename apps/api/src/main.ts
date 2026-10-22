import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Validation toàn cục đi qua APP_PIPE (I18nStandardSchemaValidationPipe) đã
  // đăng ký trong AppModule — mọi payload đều là schema Zod (ADR-009).
  app.useGlobalFilters(new ProblemDetailsFilter());
  // CORS chỉ mở cho các origin khai trong CORS_ORIGINS (mặc định là web
  // dev); không phản chiếu mọi origin như mặc định của enableCors().
  app.enableCors({
    origin: (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    credentials: true,
  });
  app.enableShutdownHooks();

  // Triển khai gộp một tiến trình (Heroku): khi WEB_DIST_DIR trỏ tới bản
  // build của web app, API phục vụ luôn các file tĩnh đó, và mọi GET
  // không thuộc /api được trả index.html để React Router tự điều hướng
  // phía client (SPA fallback). Không đặt biến này thì API giữ hành vi
  // cũ, chỉ phục vụ /api.
  const webDistDir = config.get<string>('WEB_DIST_DIR');
  if (webDistDir && existsSync(join(webDistDir, 'index.html'))) {
    app.useStaticAssets(webDistDir);
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(join(webDistDir, 'index.html'), (err) => (err ? next(err) : undefined));
    });
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('LMS API')
      .setDescription('TypeScript LMS — Moodle core business equivalent (backend)')
      .setVersion('1.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(config.get<number>('PORT') ?? 3000);
}

void bootstrap();
