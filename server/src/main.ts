import 'dotenv/config';
import 'reflect-metadata';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { appOrigin, checkConfig, isProduction, port } from './config';
import { DatabaseService } from './database/database.service';
import { seedConfiguredUsers } from './database/seed';

const API_PREFIX = '/api/v1';

function sameOrigin(request: Request, origin: string | undefined): boolean {
  if (request.get('sec-fetch-site') === 'cross-site') return false;
  const sent = request.get('origin');
  if (!sent) return true;
  if (origin) return origin === sent;
  try {
    return new URL(sent).host === request.get('host');
  } catch {
    return false;
  }
}

function setupStatic(app: NestExpressApplication): void {
  const directory = process.env.SERVE_WEB_DIR;
  if (!directory) return;
  const index = resolve(directory, 'index.html');
  if (!existsSync(index)) throw new Error('SERVE_WEB_DIR does not contain index.html');
  app.use(express.static(directory, { index: false, maxAge: '1h' }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' || request.path === '/api' || request.path.startsWith('/api/') ||
        !request.accepts('html') || /\.[a-z\d]+$/i.test(request.path)) {
      next();
      return;
    }
    response.set('Cache-Control', 'no-cache').sendFile(index);
  });
}

async function bootstrap(): Promise<void> {
  checkConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { abortOnError: false });
  try {
    const db = app.get(DatabaseService);
    await db.migrate();
    await seedConfiguredUsers(db);

    const proxyHops = Number(process.env.TRUST_PROXY_HOPS || 0);
    if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5) {
      throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5');
    }
    app.set('trust proxy', proxyHops);
    app.disable('x-powered-by');
    app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          upgradeInsecureRequests: isProduction() ? [] : null,
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
        },
      },
    }));

    const origin = appOrigin();
    app.use(API_PREFIX, (request: Request, response: Response, next: NextFunction) => {
      response.set('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request, origin)) {
        response.status(403).json({ statusCode: 403, message: 'Запрос с другого сайта отклонён.', error: 'Forbidden' });
        return;
      }
      next();
    });

    app.setGlobalPrefix(API_PREFIX.slice(1));
    app.useGlobalPipes(new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (errors) => new BadRequestException(errors.flatMap((entry) =>
        Object.entries(entry.constraints || {}).map(([rule, message]) =>
          rule === 'whitelistValidation' ? `Поле «${entry.property}» не поддерживается.` : message,
        ),
      )),
    }));
    setupStatic(app);
    app.enableShutdownHooks();
    await app.listen(port('PORT', 3001), process.env.HOST || '0.0.0.0');
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
