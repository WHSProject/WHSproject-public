import { ApprovalClient } from '../src/clients/approval.client';
import type { ApprovalRequestDto } from '../src/dto/approval-request.dto';
import { ApprovalRegistrationError } from '../src/errors/approval.errors';
import { randomUUID } from 'node:crypto';

const REQUEST: ApprovalRequestDto = {
  requestId: 'req-1',
  packages: [
    { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
    { packageName: '@scope/dep', version: '1.0.0', integrity: 'sha512-b' },
  ],
};

function response(status: number, cancelError?: Error): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      cancel: cancelError
        ? jest.fn().mockRejectedValue(cancelError)
        : jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as Response;
}

describe('ApprovalClient', () => {
  const client = new ApprovalClient();

  const originalUrl = process.env.VERDACCIO_URL;
  const originalToken = process.env.WHS_APPROVAL_SERVICE_TOKEN;

  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    delete process.env.WHS_APPROVAL_SERVICE_TOKEN;
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();

    if (originalUrl === undefined) {
      delete process.env.VERDACCIO_URL;
    } else {
      process.env.VERDACCIO_URL = originalUrl;
    }

    if (originalToken === undefined) {
      delete process.env.WHS_APPROVAL_SERVICE_TOKEN;
    } else {
      process.env.WHS_APPROVAL_SERVICE_TOKEN = originalToken;
    }
  });

  describe('요청 전송', () => {
    it('sends the service token as a Bearer authorization header', async () => {
      const token = randomUUID();
      process.env.WHS_APPROVAL_SERVICE_TOKEN = token;
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);

      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    });

    it('trims whitespace around the service token', async () => {
      const token = randomUUID();
      process.env.WHS_APPROVAL_SERVICE_TOKEN = `  ${token}\n`;
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);

      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    });

    it.each([undefined, '', '   '])(
      'omits authorization when the service token is %p',
      async (token) => {
        if (token === undefined) {
          delete process.env.WHS_APPROVAL_SERVICE_TOKEN;
        } else {
          process.env.WHS_APPROVAL_SERVICE_TOKEN = token;
        }

        fetchMock.mockResolvedValue(response(200));

        await client.register(REQUEST);

        const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);

        expect(headers.has('authorization')).toBe(false);
      },
    );

    it('posts the whole list in a single request', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];

      expect(url).toBe('http://verdaccio:4873/-/whs/approvals');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
    });

    // Plugin이 requestId를 필수로 검증한다. 없으면 400이 되어
    // ACCEPT 판정이어도 등록에 실패한다.
    it('sends the same requestId in the header and body', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      const body = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string,
      ) as ApprovalRequestDto;

      expect(body.requestId).toBe('req-1');
      const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
      expect(headers.get('x-request-id')).toBe(body.requestId);
    });

    it('sends JSON', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      const headers = fetchMock.mock.calls[0][1]?.headers as
        Record<string, string>;

      expect(headers['content-type']).toBe('application/json');
    });

    it('uses VERDACCIO_URL and strips a trailing slash', async () => {
      process.env.VERDACCIO_URL = 'http://verdaccio.internal:9999/';

      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://verdaccio.internal:9999/-/whs/approvals',
      );
    });

    it('sends an abort signal so the request cannot hang forever', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.register(REQUEST);

      expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
    });
  });

  describe('응답 처리', () => {
    it('resolves on a 200', async () => {
      fetchMock.mockResolvedValue(response(200));

      await expect(client.register(REQUEST)).resolves.toBeUndefined();
    });

    it('cancels the response body', async () => {
      const res = response(200);

      fetchMock.mockResolvedValue(res);

      await client.register(REQUEST);

      expect(res.body?.cancel).toHaveBeenCalled();
    });

    // 끊긴 연결에서 cancel이 reject하면 unhandled rejection으로 프로세스가 죽는다
    it('succeeds even when cancelling the body rejects', async () => {
      fetchMock.mockResolvedValue(response(200, new TypeError('terminated')));

      await expect(client.register(REQUEST)).resolves.toBeUndefined();
    });
  });

  describe('실패 처리', () => {
    // 등록되지 않으면 Verdaccio Guard가 어차피 막는다.
    // Gateway가 먼저 드러내야 원인이 명확하다
    it.each([201, 202, 400, 401, 403, 500, 503])(
      'throws for a %i response',
      async (status) => {
        fetchMock.mockResolvedValue(response(status));

        await expect(client.register(REQUEST)).rejects.toMatchObject({
          name: 'ApprovalRegistrationError',
          statusCode: status,
        });
      },
    );

    it('throws when the connection fails', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.register(REQUEST))
        .rejects.toBeInstanceOf(ApprovalRegistrationError);
    });

    it('throws when the request times out', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        }),
      );

      await expect(client.register(REQUEST))
        .rejects.toBeInstanceOf(ApprovalRegistrationError);
    });

    it('does not leak the Verdaccio address in the error message', async () => {
      process.env.VERDACCIO_URL = 'http://verdaccio.internal:9999';

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.register(REQUEST)).rejects.toThrow(
        /^approval registration failed$/,
      );
    });
  });
});
