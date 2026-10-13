import { ScannerClient } from '../src/clients/scanner.client';
import type { ScannerRequestDto } from '../src/dto/scanner-request.dto';
import { ScannerRequestError } from '../src/errors/scanner.errors';

const REQUEST: ScannerRequestDto = {
  requestId: 'req-1',
  packages: [
    { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
    { packageName: 'local-dep', version: '1.0.0', integrity: 'sha512-b' },
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

describe('ScannerClient', () => {
  const client = new ScannerClient();

  const originalUrl = process.env.SCANNER_URL;
  const originalTimeout = process.env.SCANNER_TIMEOUT_MS;

  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();

    if (originalUrl === undefined) {
      delete process.env.SCANNER_URL;
    } else {
      process.env.SCANNER_URL = originalUrl;
    }

    if (originalTimeout === undefined) {
      delete process.env.SCANNER_TIMEOUT_MS;
    } else {
      process.env.SCANNER_TIMEOUT_MS = originalTimeout;
    }
  });

  describe('요청 전송', () => {
    it('posts the whole batch in a single request', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.scan(REQUEST);

      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0];

      expect(url).toBe('http://scanner:3001/internal/v1/scans');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
    });

    it('sends JSON', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.scan(REQUEST);

      const headers = fetchMock.mock.calls[0][1]?.headers as
        Record<string, string>;

      expect(headers['content-type']).toBe('application/json');
    });

    // Gateway Critical Path에 진입한 Package의 integrity는 필수다.
    it('sends the required integrity unchanged', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.scan(REQUEST);

      const body = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string,
      ) as ScannerRequestDto;

      expect(body.packages[1].integrity).toBe('sha512-b');
    });

    it('uses SCANNER_URL and strips a trailing slash', async () => {
      process.env.SCANNER_URL = 'http://scanner.internal:9999/';

      fetchMock.mockResolvedValue(response(200));

      await client.scan(REQUEST);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://scanner.internal:9999/internal/v1/scans',
      );
    });

    it('sends an abort signal so the request cannot hang forever', async () => {
      fetchMock.mockResolvedValue(response(200));

      await client.scan(REQUEST);

      expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
    });
  });

  describe('응답 처리', () => {
    // Scanner와 200으로 합의했다
    // MVP 기준 200을 제외한 어떤 상태 코드도 통과시키지 않는다.
    it('resolves on a 200', async () => {
      fetchMock.mockResolvedValue(response(200));

      await expect(client.scan(REQUEST)).resolves.toBeUndefined();
    });

    // 202는 "접수함, 처리 중"이라 분석 완료를 보장하지 않는다.
    // 201은 NestJS @Post()의 기본 응답이라 실수로 나올 수 있는데,
    // 합의된 상태가 아니므로 통과시키지 않는다.
    it.each([201, 202, 204, 206])(
      'rejects a %i even though it is 2xx',
      async (status) => {
        fetchMock.mockResolvedValue(response(status));

        await expect(client.scan(REQUEST)).rejects.toMatchObject({
          name: 'ScannerRequestError',
          statusCode: status,
        });
      },
    );

    // 본문은 사용하지 않으므로 연결이 재사용될 수 있도록 정리한다
    it('cancels the response body', async () => {
      const res = response(200);

      fetchMock.mockResolvedValue(res);

      await client.scan(REQUEST);

      expect(res.body?.cancel).toHaveBeenCalled();
    });

    it('cancels the response body on a failure too', async () => {
      const res = response(500);

      fetchMock.mockResolvedValue(res);

      await expect(client.scan(REQUEST)).rejects.toBeInstanceOf(
        ScannerRequestError,
      );
      expect(res.body?.cancel).toHaveBeenCalled();
    });

    // 이미 끊긴 연결에서는 cancel이 reject한다(TypeError: terminated).
    // 처리하지 않으면 unhandled rejection으로 프로세스가 종료된다.
    it('succeeds even when cancelling the body rejects', async () => {
      fetchMock.mockResolvedValue(
        response(200, new TypeError('terminated')),
      );

      await expect(client.scan(REQUEST)).resolves.toBeUndefined();
    });

    it('still reports the HTTP failure when cancelling rejects', async () => {
      fetchMock.mockResolvedValue(
        response(503, new TypeError('terminated')),
      );

      await expect(client.scan(REQUEST)).rejects.toMatchObject({
        name: 'ScannerRequestError',
        statusCode: 503,
      });
    });
  });

  describe('실패 처리', () => {
    // 분석되지 않은 Package가 검사 없이 통과하면 안 되므로 전부 실패로 다룬다
    it.each([400, 403, 404, 429, 500, 503])(
      'throws a request error for a %i response',
      async (status) => {
        fetchMock.mockResolvedValue(response(status));

        await expect(client.scan(REQUEST)).rejects.toMatchObject({
          name: 'ScannerRequestError',
          statusCode: status,
        });
      },
    );

    it('throws a request error when the connection fails', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.scan(REQUEST))
        .rejects.toBeInstanceOf(ScannerRequestError);
    });

    // 분석이 끝나지 않았으므로 통과시키면 안 된다
    it('throws a request error when the request times out', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        }),
      );

      await expect(client.scan(REQUEST))
        .rejects.toBeInstanceOf(ScannerRequestError);
    });

    // 실패 원인이 응답 본문으로 새어나가면 안 된다
    it('does not leak the Scanner address in the error message', async () => {
      process.env.SCANNER_URL = 'http://scanner.internal:9999';

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(client.scan(REQUEST)).rejects.toThrow(
        /^scan request failed$/,
      );
    });
  });
});
