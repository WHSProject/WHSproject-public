import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { Injectable } from '@nestjs/common';

import {
  resolveVerdaccioBaseUrl,
  resolveVerdaccioTimeoutMs,
} from '../config/verdaccio.config';
import { VerdaccioForwardError } from '../errors/verdaccio.errors';
import type {
  VerdaccioForwardRequest,
  VerdaccioForwardResult,
} from '../types/verdaccio.types';

// 연결 단위 Header는 중계하지 않는다. 그대로 넘기면 응답이 깨진다.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 요청에서 추가로 제외할 Header.
// host는 Verdaccio 주소로 다시 만들어져야 하고, accept-encoding을 넘기면
// 압축된 응답이 와서 content-length가 실제 본문과 어긋난다.
const EXCLUDED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'host',
  'accept-encoding',
  'content-length',
  'authorization',
  'cookie',
]);

@Injectable()
export class VerdaccioClient {
  // npm 요청을 Verdaccio로 그대로 중계한다.
  //
  // 응답 본문은 읽지 않고 스트림으로 넘긴다. tarball은 바이너리라 문자열로
  // 변환하는 순간 파일이 손상된다.
  // 요청 본문도 파싱하지 않은 원본 바이트를 그대로 전달한다.
  async forward(
    request: VerdaccioForwardRequest,
  ): Promise<VerdaccioForwardResult> {
    const { method, path, headers, body } = request;

    if (!['GET', 'HEAD'].includes(method) || path.startsWith('/-/')) {
      throw new Error('Only package reads may use the Verdaccio service account');
    }
    const url = `${resolveVerdaccioBaseUrl()}${path}`;

    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        method,
        redirect: 'error',
        headers: this.buildRequestHeaders(headers),
        // 본문은 파싱하지 않은 원본 바이트를 그대로 전달한다.
        // Buffer는 런타임에 유효한 fetch 본문이지만, TypeScript의 BodyInit
        // 정의가 Node의 Buffer 타입을 받지 않아 변환이 필요하다.
        ...(body === undefined
          ? {}
          : { body: body as unknown as BodyInit }),
        signal: AbortSignal.timeout(resolveVerdaccioTimeoutMs()),
      });
    } catch (error) {
      throw new VerdaccioForwardError(path, error);
    }

    // 403은 Verdaccio의 승인·무결성 차단일 수도 있으므로 기존 응답을 보존한다.
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Error('Verdaccio service account access denied');
    }
    return {
      status: response.status,
      headers: this.buildResponseHeaders(response.headers),
      // fetch가 주는 Web Stream과 Node Stream 타입 정의가 달라 변환이 필요하다
      body: response.body
        ? Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
        : null,
    };
  }

  // 사용자 자격증명은 제거하고 패키지 읽기 전용 서비스 계정으로 교체한다.
  private buildRequestHeaders(
    requestHeaders: Record<string, string | string[] | undefined>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(requestHeaders)) {
      if (value === undefined || EXCLUDED_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue;
      }

      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    const user = process.env.VERDACCIO_SERVICE_USER;
    const password = process.env.VERDACCIO_SERVICE_PASSWORD;
    if (!user || !password || user.includes(':')) throw new Error('Verdaccio service credentials are not configured');
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    return headers;
  }

  private buildResponseHeaders(
    responseHeaders: Headers,
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    // fetch는 accept-encoding을 자동으로 붙이고 응답 본문의 압축도 자동으로
    // 푼다. 그래서 content-encoding과 content-length가 실제 본문과 어긋난다.
    // 그대로 전달하면 npm이 압축을 풀려다 zlib 오류로 실패한다(실측).
    const decompressed = responseHeaders.has('content-encoding');

    for (const [name, value] of responseHeaders.entries()) {
      if (HOP_BY_HOP_HEADERS.has(name)) {
        continue;
      }

      if (decompressed
        && (name === 'content-encoding' || name === 'content-length')) {
        continue;
      }

      headers[name] = value;
    }

    return headers;
  }
}
