import { DecisionLookupClient } from '../src/clients/decision-lookup.client';
import {
  DecisionLookupInvalidResponseError,
  DecisionLookupRequestError,
} from '../src/errors/decision-lookup.errors';
import type { DecisionLookupRequestDto } from '../src/dto/decision-lookup.dto';

const REQUEST: DecisionLookupRequestDto = {
  requestId: 'req-1',
  packages: [
    { packageName: 'express', version: '5.2.1', integrity: 'sha512-a' },
    { packageName: 'local-dep', version: '1.0.0', integrity: 'sha512-b' },
  ],
};

function createResponse({
  ok,
  status,
  body,
  jsonError,
}: {
  ok: boolean;
  status: number;
  body?: unknown;
  jsonError?: Error;
}): Response {
  return {
    ok,
    status,
    json: jsonError
      ? jest.fn().mockRejectedValue(jsonError)
      : jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('DecisionLookupClient', () => {
  const client = new DecisionLookupClient();

  const originalUrl = process.env.DECISION_DB_URL;

  let fetchMock: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();

    if (originalUrl === undefined) {
      delete process.env.DECISION_DB_URL;
      return;
    }

    process.env.DECISION_DB_URL = originalUrl;
  });

  it('posts the whole batch in a single request', async () => {
    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      body: { results: [] },
    }));

    await client.lookup(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe(
      'http://decision-db-api:9100/internal/v1/decisions/lookup',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
  });

  it('sends the required integrity unchanged', async () => {
    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      body: { results: [] },
    }));

    await client.lookup(REQUEST);

    const body = JSON.parse(
      fetchMock.mock.calls[0][1]?.body as string,
    ) as DecisionLookupRequestDto;

    expect(body.packages[1].integrity).toBe('sha512-b');
  });

  it('uses DECISION_DB_URL and strips a trailing slash', async () => {
    process.env.DECISION_DB_URL = 'http://decision-db.internal:9999/';

    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      body: { results: [] },
    }));

    await client.lookup(REQUEST);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://decision-db.internal:9999/internal/v1/decisions/lookup',
    );
  });

  it('returns the response body unparsed', async () => {
    const body = { results: [{ lookupStatus: 'NOT_FOUND' }] };

    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      body,
    }));

    await expect(client.lookup(REQUEST)).resolves.toBe(body);
  });

  it('throws a request error for a failed HTTP response', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: false, status: 503 }));

    await expect(client.lookup(REQUEST)).rejects.toMatchObject({
      name: 'DecisionLookupRequestError',
      statusCode: 503,
    });
  });

  it('throws a request error when the connection fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.lookup(REQUEST))
      .rejects.toBeInstanceOf(DecisionLookupRequestError);
  });

  // 조회 서버가 응답하지 않으면 npm 요청 전체가 매달린다
  it('throws a request error when the request times out', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );

    await expect(client.lookup(REQUEST))
      .rejects.toBeInstanceOf(DecisionLookupRequestError);
  });

  it('sends an abort signal so the request cannot hang forever', async () => {
    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      body: { results: [] },
    }));

    await client.lookup(REQUEST);

    expect(fetchMock.mock.calls[0][1]?.signal).toBeDefined();
  });

  it('throws an invalid response error when JSON parsing fails', async () => {
    fetchMock.mockResolvedValue(createResponse({
      ok: true,
      status: 200,
      jsonError: new SyntaxError('invalid JSON'),
    }));

    await expect(client.lookup(REQUEST))
      .rejects.toBeInstanceOf(DecisionLookupInvalidResponseError);
  });
});
