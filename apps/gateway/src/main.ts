import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { GatewayModule } from './gateway.module';

export function createGatewayApplication(
  rootModule: Type<unknown> = GatewayModule,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  });

  const instance = adapter.getInstance();

  // 요청 본문을 파싱하지 않고 원본 바이트 그대로 Verdaccio에 넘긴다.
  // JSON 파서를 거치면 재직렬화 과정에서 키 순서 등 원본 형태가 깨진다.
  // addContentTypeParser를 직접 쓰면 Nest 초기화가 JSON 파서를 다시 등록해
  // 덮어쓰므로(registerParserMiddleware), useBodyParser로 등록한다.
  instance.removeAllContentTypeParsers();
  adapter.useBodyParser('*', false, {}, (_request, body, done) =>
    done(null, body));

  instance.addHook('onRequest', (request, reply, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  return NestFactory.create<NestFastifyApplication>(rootModule, adapter);
}

async function bootstrap(): Promise<void> {
  const app = await createGatewayApplication();

  const port = Number(process.env.GATEWAY_PORT ?? 3000);

  await app.listen(port, '0.0.0.0');
}

if (require.main === module) {
  void bootstrap();
}
