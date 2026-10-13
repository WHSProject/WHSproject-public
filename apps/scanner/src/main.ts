import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { loadScannerEnvironment } from './config/scanner-environment';

export function createScannerApplication(): Promise<NestFastifyApplication> {
  return NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
}

export async function bootstrap(): Promise<void> {
  loadScannerEnvironment();

  const port = process.env.SCANNER_PORT;

  if (port === undefined) {
    throw new Error('SCANNER_PORT must be configured before starting Scanner');
  }

  const app = await createScannerApplication();

  await app.listen(port, '0.0.0.0');
}

if (require.main === module) {
  void bootstrap();
}
