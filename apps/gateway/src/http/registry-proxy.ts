import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { VerdaccioClient } from '../clients/verdaccio.client';

const NPM_PREFIX = '/npm';

// npm 요청을 Verdaccio로 중계하는 공통 처리.
// `/npm` 접두사는 Verdaccio의 `url_prefix: /npm/`와 맞춘 값이라 여기서만 제거한다.
@Injectable()
export class RegistryProxy {
  constructor(private readonly verdaccioClient: VerdaccioClient) {}

  async forward(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // 원본 URL에서 /npm만 제거하고, Query와 Percent Encoding은 그대로 보존
    const path = request.url.slice(NPM_PREFIX.length) || '/';

    const result = await this.verdaccioClient.forward({
      method: request.method,
      path,
      headers: {
        ...request.headers,
        'x-request-id': request.id,
        'x-forwarded-for': request.ip,
      },
      body: Buffer.isBuffer(request.body) ? request.body : undefined,
    });

    reply.status(result.status);

    for (const [name, value] of Object.entries(result.headers)) {
      reply.header(name, value);
    }

    // Verdaccio 응답에 다른 ID가 있어도 Gateway의 요청 ID를 유지
    reply.header('x-request-id', request.id);

    // 응답 본문은 스트림으로 전달
    await reply.send(result.body ?? '');
  }
}