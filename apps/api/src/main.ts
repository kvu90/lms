import { VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem-details.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Validation toàn cục đi qua APP_PIPE (I18nStandardSchemaValidationPipe) đã
  // đăng ký trong AppModule — mọi payload đều là schema Zod (ADR-009).
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableCors();
  app.enableShutdownHooks();

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
