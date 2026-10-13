import { Readable } from 'node:stream';

import { VerdaccioClient } from '../src/clients/verdaccio.client';
import { VerdaccioForwardError } from '../src/errors/verdaccio.errors';

function upstreamResponse({
  status = 200,
  headers = {},
  body = 'ok',
}: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
} = {}): Response {
  return {
    status,
    headers: new Headers(headers),
    body: body === null
      ? null
      : new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
  } as unknown as Response;
}

async function readAll(stream: Readable | null): Promise<string> {
  if (!stream) {
    return '';
  }

  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString();
}

describe('VerdaccioClient', () => {
  const client = new VerdaccioClient();

  const originalUrl = process.env.VERDACCIO_URL;

  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    process.env.VERDACCIO_SERVICE_USER = 'gateway-reader';
    process.env.VERDACCIO_SERVICE_PASSWORD = 'test-only-password';
    fetchMock = jest.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValue(upstreamResponse());
  });

  afterEach(() => {
    fetchMock.mockRestore();

    if (originalUrl === undefined) {
      delete process.env.VERDACCIO_URL;
      return;
    }

    process.env.VERDACCIO_URL = originalUrl;
  });

  it('forwards to the configured Verdaccio address', async () => {
    await client.forward({ method: 'GET', path: '/express', headers: {} });

    expect(fetchMock.mock.calls[0][0])
      .toBe('http://verdaccio:4873/express');
  });

  it('uses VERDACCIO_URL and strips a trailing slash', async () => {
    process.env.VERDACCIO_URL = 'http://127.0.0.1:4873/';

    await client.forward({ method: 'GET', path: '/express', headers: {} });

    expect(fetchMock.mock.calls[0][0])
      .toBe('http://127.0.0.1:4873/express');
  });

  it('keeps the path exactly as given', async () => {
    await client.forward({ method: 'GET', path: '/@babel%2fcore/-/core-8.0.1.tgz', headers: {} });

    expect(fetchMock.mock.calls[0][0])
      .toBe('http://verdaccio:4873/@babel%2fcore/-/core-8.0.1.tgz');
  });

  // Gateway는 JWT를 검증하지 않고 그대로 넘긴다
  it('forwards the Authorization header', async () => {
    await client.forward({ method: 'GET', path: '/express', headers: {
      authorization: 'Bearer token-abc',
      accept: 'application/json',
    } });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;

    expect(headers.authorization).toBe(`Basic ${Buffer.from('gateway-reader:test-only-password').toString('base64')}`);
    expect(headers.accept).toBe('application/json');
  });

  it.each([
    'host',
    'connection',
    'transfer-encoding',
    'accept-encoding',
    'content-length',
  ])('does not forward the %s header', async (name) => {
    await client.forward({ method: 'GET', path: '/express', headers: {
      [name]: 'value',
      authorization: 'Bearer t',
    } });

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;

    expect(headers).not.toHaveProperty(name);
    expect(headers.authorization).toBe(`Basic ${Buffer.from('gateway-reader:test-only-password').toString('base64')}`);
  });

  it('returns the upstream status and headers', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '1234',
        etag: '"abc"',
      },
    }));

    const result = await client.forward({ method: 'GET', path: '/express/-/express-5.2.1.tgz', headers: {} });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/octet-stream');
    expect(result.headers['content-length']).toBe('1234');
    expect(result.headers.etag).toBe('"abc"');
  });

  it('does not return hop-by-hop response headers', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({
      headers: { connection: 'keep-alive', 'content-type': 'application/json' },
    }));

    const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

    expect(result.headers).not.toHaveProperty('connection');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('returns the body without reading it', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({ body: '{"name":"express"}' }));

    const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

    await expect(readAll(result.body)).resolves.toBe('{"name":"express"}');
  });

  it('passes through a non-2xx status without throwing', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({ status: 404, body: 'nope' }));

    const result = await client.forward({ method: 'GET', path: '/missing', headers: {} });

    expect(result.status).toBe(404);
  });

  it('returns a null body when the upstream has none', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({ status: 304, body: null }));

    const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

    expect(result.body).toBeNull();
  });

  it('throws a forward error when the connection fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.forward({ method: 'GET', path: '/express', headers: {} }))
      .rejects.toBeInstanceOf(VerdaccioForwardError);
  });

  it('throws a forward error when the request times out', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );

    await expect(client.forward({ method: 'GET', path: '/express', headers: {} }))
      .rejects.toBeInstanceOf(VerdaccioForwardError);
  });

  it('sends an abort signal so the request cannot hang forever', async () => {
    await client.forward({ method: 'GET', path: '/express', headers: {} });

    expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
  });
  // fetch가 accept-encoding을 자동으로 붙여 응답이 압축되어 오고, 본문은
  // 자동으로 풀린다. content-encoding을 그대로 넘기면 npm이 이미 풀린 본문을
  // 다시 풀려다 zlib 오류로 실패한다(실측).
  describe('자동 압축 해제 처리', () => {
    it('drops content-encoding when the body was decompressed', async () => {
      fetchMock.mockResolvedValue(upstreamResponse({
        headers: {
          'content-encoding': 'gzip',
          'content-length': '512',
          'content-type': 'application/json',
        },
      }));

      const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

      expect(result.headers).not.toHaveProperty('content-encoding');
      expect(result.headers['content-type']).toBe('application/json');
    });

    it('drops the stale content-length along with it', async () => {
      fetchMock.mockResolvedValue(upstreamResponse({
        headers: { 'content-encoding': 'gzip', 'content-length': '512' },
      }));

      const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

      expect(result.headers).not.toHaveProperty('content-length');
    });

    it('keeps content-length when the body was not compressed', async () => {
      fetchMock.mockResolvedValue(upstreamResponse({
        headers: { 'content-length': '3730' },
      }));

      const result = await client.forward({ method: 'GET', path: '/express', headers: {} });

      expect(result.headers['content-length']).toBe('3730');
    });
  });
  it.each(['PUT', 'POST', 'DELETE'])('rejects %s without sending service credentials', async (method) => {
    await expect(client.forward({ method, path: '/express', headers: {} })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects internal paths', async () => {
    await expect(client.forward({ method: 'GET', path: '/-/user/admin', headers: {} })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['VERDACCIO_SERVICE_USER', 'VERDACCIO_SERVICE_PASSWORD'])('fails closed without %s', async (key) => {
    delete process.env[key];
    await expect(client.forward({ method: 'GET', path: '/express', headers: {} })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401])('turns upstream credential rejection %i into a server failure without fallback', async (status) => {
    fetchMock.mockResolvedValue(upstreamResponse({ status }));
    await expect(client.forward({ method: 'GET', path: '/express', headers: {} })).rejects.toThrow('service account');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves upstream policy and integrity 403 rejections without retry', async () => {
    fetchMock.mockResolvedValue(upstreamResponse({ status: 403, body: 'policy denied' }));
    const result = await client.forward({ method: 'GET', path: '/express', headers: {} });
    expect(result.status).toBe(403);
    expect(await readAll(result.body)).toBe('policy denied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('strips cookies and Authorization regardless of casing', async () => {
    await client.forward({ method: 'GET', path: '/express', headers: { Authorization: 'Bearer user-token', Cookie: 'session=secret' } });
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
    expect(headers).not.toHaveProperty('Cookie');
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });
});
