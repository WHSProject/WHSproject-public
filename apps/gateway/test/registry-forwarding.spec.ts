import { NpmAuthService } from '../src/services/npm-auth.service';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

// Arborist는 실제 Registry에 요청을 보내므로 Route 테스트에서는 대체한다.
jest.mock('@npmcli/arborist', () => ({
  Arborist: jest.fn().mockImplementation(() => ({
    buildIdealTree: jest.fn(async ({ add }: { add: string[] }) => {
      const spec = add[0];
      const separator = spec.lastIndexOf('@');
      const name = spec.slice(0, separator);
      const version = spec.slice(separator + 1);

      return {
        inventory: {
          values: () => [
            {
              name: 'whs-gateway-arborist-tmp',
              version: '',
              integrity: null,
              isProjectRoot: true,
            },
            { name, version, integrity: 'sha512-root', isProjectRoot: false },
            {
              name: 'dep-a',
              version: '1.0.0',
              integrity: 'sha512-a',
              isProjectRoot: false,
            },
          ],
        },
      };
    }),
  })),
}));

// eslint-disable-next-line import/first
import { createGatewayApplication } from '../src/main';
// eslint-disable-next-line import/first
import { Arborist } from '@npmcli/arborist';
// eslint-disable-next-line import/first
import {
  AnalyzedArtifactRegistry,
} from '../src/cache/analyzed-artifact.registry';

// 트리를 실제로 다시 만들었는지 세려면 생성자 호출 수를 본다.
const arboristMock = Arborist as unknown as jest.Mock;

const LOOKUP_URL = 'http://decision-db-api:9100/internal/v1/decisions/lookup';
const SCAN_URL = 'http://scanner:3001/internal/v1/scans';
const APPROVAL_URL = 'http://verdaccio:4873/-/whs/approvals';
const VERDACCIO = 'http://verdaccio:4873';

const TARBALL_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]);

interface LookupPackage {
  packageName: string;
  version: string;
  integrity: string;
}

function streamOf(payload: Buffer | string): ReadableStream {
  const bytes = Buffer.isBuffer(payload)
    ? new Uint8Array(payload)
    : new TextEncoder().encode(payload);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function upstream(
  payload: Buffer | string,
  headers: Record<string, string>,
  status = 200,
): Response {
  return {
    status,
    headers: new Headers(headers),
    body: streamOf(payload),
    json: jest.fn(),
  } as unknown as Response;
}

const PACKUMENT = JSON.stringify({
  name: 'lodash',
  'dist-tags': { latest: '4.17.21' },
  versions: {
    '4.17.21': {
      dist: {
        tarball: 'http://localhost:3000/npm/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-root',
      },
    },
  },
});

describe('Registry Forwarding', () => {
  let app: NestFastifyApplication;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let lookupCount = 0;

  // npm 요청 중계만 센다. 승인 등록도 Verdaccio로 가지만 중계가 아니다.
  function verdaccioCalls(): [string, RequestInit | undefined][] {
    return fetchMock.mock.calls.filter(
      ([url]) => String(url).startsWith(VERDACCIO)
        && String(url) !== APPROVAL_URL,
    ) as [string, RequestInit | undefined][];
  }

  function lookupCalls(): [string, RequestInit | undefined][] {
    return fetchMock.mock.calls.filter(
      ([url]) => String(url) === LOOKUP_URL,
    ) as [string, RequestInit | undefined][];
  }

  function scanCalls(): [string, RequestInit | undefined][] {
    return fetchMock.mock.calls.filter(
      ([url]) => String(url) === SCAN_URL,
    ) as [string, RequestInit | undefined][];
  }

  // 실제 ReadableStream.cancel()은 Promise를 반환한다.
  // 동기 mock을 쓰면 client의 .catch()에서 TypeError가 나 요청이 500이 된다.
  function scanResponse(status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as unknown as Response;
  }

  function approvalResponse(status = 200): Response {
    return scanResponse(status);
  }

  function approvalCalls(): [string, RequestInit | undefined][] {
    return fetchMock.mock.calls.filter(
      ([url]) => String(url) === APPROVAL_URL,
    ) as [string, RequestInit | undefined][];
  }

  // Decision 조회 응답. lookupStatus와 decision을 지정한다.
  function lookupResponse(
    init: RequestInit | undefined,
    lookupStatus: 'FOUND' | 'NOT_FOUND',
    decision = 'ACCEPT',
  ): Response {
    const body = JSON.parse(init?.body as string) as {
      packages: LookupPackage[];
    };

    return {
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        results: body.packages.map((pkg) => (
          lookupStatus === 'FOUND'
            ? {
              ...pkg,
              lookupStatus,
              decisionId: 'decision-1',
              decision,
              evaluatedAt: '2026-08-26T00:00:00.000Z',
            }
            : { ...pkg, lookupStatus }
        )),
      }),
    } as unknown as Response;
  }

  beforeAll(async () => {
    app = await createGatewayApplication();
    jest.spyOn(app.get(NpmAuthService), 'authenticate').mockResolvedValue({ userId: 'user-1', username: 'alice' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    process.env.VERDACCIO_SERVICE_USER = 'gateway-reader';
    process.env.VERDACCIO_SERVICE_PASSWORD = 'test-only-password';
    lookupCount = 0;

    // 분석 기억은 프로세스 전역이라 Test 간에 남는다.
    // 남겨 두면 앞 Test에서 분석한 Package가 뒤 Test의 트리 구성을 건너뛰게 한다.
    app.get(AnalyzedArtifactRegistry).clear();
    arboristMock.mockClear();

    fetchMock = jest.spyOn(globalThis, 'fetch');

    fetchMock.mockImplementation(async (url, init) => {
      const target = String(url);

      // 첫 조회는 NOT_FOUND, Scanner 이후 재조회는 FOUND + ACCEPT.
      // 실제 흐름(Scanner가 분석하고 Decision을 저장)을 흉내낸다.
      if (target === LOOKUP_URL) {
        lookupCount += 1;

        return lookupResponse(
          init,
          lookupCount === 1 ? 'NOT_FOUND' : 'FOUND',
        );
      }

      if (target === SCAN_URL) {
        return scanResponse();
      }

      if (target === APPROVAL_URL) {
        return approvalResponse();
      }

      if (target.endsWith('.tgz')) {
        return upstream(TARBALL_BYTES, {
          'content-type': 'application/octet-stream',
          'content-length': String(TARBALL_BYTES.length),
          etag: '"tarball-etag"',
        });
      }

      return upstream(PACKUMENT, { 'content-type': 'application/json' });
    });
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('Metadata 요청', () => {
    it('forwards to Verdaccio with the /npm prefix removed', async () => {
      const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(response.statusCode).toBe(200);
      expect(verdaccioCalls()[0][0]).toBe(`${VERDACCIO}/lodash`);
    });

    it('forwards a scoped package path', async () => {
      await app.inject({ method: 'GET', url: '/npm/@babel/core' });

      expect(verdaccioCalls()[0][0]).toBe(`${VERDACCIO}/@babel/core`);
    });

    it('keeps percent-encoding as sent', async () => {
      await app.inject({ method: 'GET', url: '/npm/@babel%2fcore' });

      expect(verdaccioCalls()[0][0]).toBe(`${VERDACCIO}/@babel%2fcore`);
    });

    it('returns the packument unchanged', async () => {
      const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(response.payload).toBe(PACKUMENT);
      expect(response.headers['content-type']).toContain('application/json');
    });

    // Metadata 시점에는 어떤 Version이 선택될지 알 수 없어 검사하지 않는다
    it('does not run the analysis', async () => {
      await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(lookupCalls()).toHaveLength(0);
    });
  });

  describe('Tarball 요청', () => {
    it('forwards to Verdaccio with the /npm prefix removed', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(200);
      expect(verdaccioCalls()[0][0])
        .toBe(`${VERDACCIO}/lodash/-/lodash-4.17.21.tgz`);
    });

    it('forwards a scoped tarball path', async () => {
      await app.inject({
        method: 'GET',
        url: '/npm/@babel/core/-/core-8.0.1.tgz',
      });

      expect(verdaccioCalls()[0][0])
        .toBe(`${VERDACCIO}/@babel/core/-/core-8.0.1.tgz`);
    });

    // package-lock.json이 있으면 Metadata 요청이 없으므로(실측)
    // 검사는 반드시 tarball 요청에서 동작해야 한다
    it('runs the analysis using the version from the path', async () => {
      await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(lookupCalls()).toHaveLength(1);

      const body = JSON.parse(lookupCalls()[0][1]?.body as string) as {
        packages: LookupPackage[];
      };

      expect(body.packages).toEqual([
        { packageName: 'lodash', version: '4.17.21', integrity: 'sha512-root' },
        { packageName: 'dep-a', version: '1.0.0', integrity: 'sha512-a' },
      ]);
    });

    it('returns the tarball bytes unchanged', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(Buffer.compare(response.rawPayload, TARBALL_BYTES)).toBe(0);
    });

    it('keeps the upstream response headers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.headers['content-type'])
        .toBe('application/octet-stream');
      expect(response.headers.etag).toBe('"tarball-etag"');
    });

    it('does not forward when the file name does not match the package',
      async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/npm/lodash/-/express-5.2.1.tgz',
        });

        expect(response.statusCode).toBe(400);
        expect(verdaccioCalls()).toHaveLength(0);
      });

    it('does not forward when the version is not an exact semver', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-latest.tgz',
      });

      expect(response.statusCode).toBe(400);
      expect(verdaccioCalls()).toHaveLength(0);
    });

    it('rejects before downstream calls when integrity is missing', async () => {
      arboristMock.mockImplementationOnce(() => ({
        buildIdealTree: jest.fn(async () => ({
          inventory: {
            values: () => [
              {
                name: 'whs-gateway-arborist-tmp',
                version: '',
                integrity: null,
                isProjectRoot: true,
              },
              {
                name: 'lodash',
                version: '4.17.21',
                integrity: null,
                isProjectRoot: false,
              },
            ],
          },
        })),
      }));

      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('INVALID_REQUEST');

      // integrity가 없으면 Security 판정 이전에 Gateway에서 중단한다.
      expect(lookupCalls()).toHaveLength(0);
      expect(scanCalls()).toHaveLength(0);
      expect(approvalCalls()).toHaveLength(0);
      expect(verdaccioCalls()).toHaveLength(0);
    });
  });

  describe('Scanner 분석 요청', () => {
    const originalEnabled = process.env.SCANNER_ENABLED;

    afterEach(() => {
      if (originalEnabled === undefined) {
        delete process.env.SCANNER_ENABLED;
      } else {
        process.env.SCANNER_ENABLED = originalEnabled;
      }
    });

    // Scanner 라우트가 아직 없어 기본은 꺼져 있다
    it('does not call the Scanner when disabled', async () => {
      delete process.env.SCANNER_ENABLED;

      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(200);
      expect(verdaccioCalls()).toHaveLength(1);
      expect(scanCalls()).toHaveLength(0);
    });

    it('sends every NOT_FOUND package in a single request when enabled',
      async () => {
        process.env.SCANNER_ENABLED = 'true';

        const response = await app.inject({
          method: 'GET',
          url: '/npm/lodash/-/lodash-4.17.21.tgz',
        });

        // 분석 요청이 나가도 설치는 정상적으로 끝나야 한다
        expect(response.statusCode).toBe(200);
        expect(verdaccioCalls()).toHaveLength(1);

        expect(scanCalls()).toHaveLength(1);

        const [url, init] = scanCalls()[0];

        expect(url).toBe(SCAN_URL);
        expect(init?.method).toBe('POST');

        const body = JSON.parse(init?.body as string) as {
          packages: LookupPackage[];
        };

        expect(body.packages).toEqual([
          { packageName: 'lodash', version: '4.17.21', integrity: 'sha512-root' },
          { packageName: 'dep-a', version: '1.0.0', integrity: 'sha512-a' },
        ]);
      });

    it('reuses the requestId sent to the Decision lookup', async () => {
      process.env.SCANNER_ENABLED = 'true';

      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(200);

      const lookupBody = JSON.parse(
        lookupCalls()[0][1]?.body as string,
      ) as { requestId: string };
      const scanBody = JSON.parse(
        scanCalls()[0][1]?.body as string,
      ) as { requestId: string };

      expect(scanBody.requestId).toBe(lookupBody.requestId);
    });

    it('does not call the Scanner when every package is already decided',
      async () => {
        process.env.SCANNER_ENABLED = 'true';

        fetchMock.mockImplementation(async (url, init) => {
          const target = String(url);

          if (target === LOOKUP_URL) {
            const body = JSON.parse(init?.body as string) as {
              packages: LookupPackage[];
            };

            return {
              ok: true,
              status: 200,
              json: jest.fn().mockResolvedValue({
                results: body.packages.map((pkg) => ({
                  ...pkg,
                  lookupStatus: 'FOUND',
                  decisionId: 'decision-1',
                  decision: 'ACCEPT',
                  evaluatedAt: '2026-08-24T00:00:00.000Z',
                })),
              }),
            } as unknown as Response;
          }

          return upstream(TARBALL_BYTES, {
            'content-type': 'application/octet-stream',
          });
        });

        const response = await app.inject({
          method: 'GET',
          url: '/npm/lodash/-/lodash-4.17.21.tgz',
        });

        expect(response.statusCode).toBe(200);
        expect(scanCalls()).toHaveLength(0);
      });

    it('does not call the Scanner for a metadata request', async () => {
      process.env.SCANNER_ENABLED = 'true';

      const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(response.statusCode).toBe(200);
      expect(scanCalls()).toHaveLength(0);
    });

    // 분석되지 않은 Package를 통과시키면 안 된다
    it('fails the request when the Scanner is unreachable', async () => {
      process.env.SCANNER_ENABLED = 'true';

      fetchMock.mockImplementation(async (url, init) => {
        const target = String(url);

        if (target === SCAN_URL) {
          throw new Error('ECONNREFUSED');
        }

        if (target === LOOKUP_URL) {
          const body = JSON.parse(init?.body as string) as {
            packages: LookupPackage[];
          };

          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              results: body.packages.map((pkg) => ({
                ...pkg,
                lookupStatus: 'NOT_FOUND',
              })),
            }),
          } as unknown as Response;
        }

        return upstream(TARBALL_BYTES, {
          'content-type': 'application/octet-stream',
        });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('GATEWAY_INTERNAL_ERROR');
      expect(response.payload).not.toContain('scanner');
      expect(verdaccioCalls()).toHaveLength(0);
    });

    // Scanner가 완료가 아닌 2xx를 주면 분석 전에 Package가 나갈 수 있다
    it('fails the request when the Scanner returns 202', async () => {
      process.env.SCANNER_ENABLED = 'true';

      fetchMock.mockImplementation(async (url, init) => {
        const target = String(url);

        if (target === SCAN_URL) {
          return scanResponse(202);
        }

        if (target === LOOKUP_URL) {
          const body = JSON.parse(init?.body as string) as {
            packages: LookupPackage[];
          };

          return {
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              results: body.packages.map((pkg) => ({
                ...pkg,
                lookupStatus: 'NOT_FOUND',
              })),
            }),
          } as unknown as Response;
        }

        return upstream(TARBALL_BYTES, {
          'content-type': 'application/octet-stream',
        });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });

      expect(response.statusCode).toBe(500);
      expect(verdaccioCalls()).toHaveLength(0);
    });
  });

  describe('Decision 집행', () => {
    const originalEnabled = process.env.SCANNER_ENABLED;

    afterEach(() => {
      if (originalEnabled === undefined) {
        delete process.env.SCANNER_ENABLED;
      } else {
        process.env.SCANNER_ENABLED = originalEnabled;
      }
    });

    // 조회에 필요한 것만 바꾸고 나머지는 기본 mock을 따른다
    function mockLookup(
      lookupStatus: 'FOUND' | 'NOT_FOUND',
      decision = 'ACCEPT',
      approvalStatus = 200,
    ): void {
      fetchMock.mockImplementation(async (url, init) => {
        const target = String(url);

        if (target === LOOKUP_URL) {
          return lookupResponse(init, lookupStatus, decision);
        }

        if (target === APPROVAL_URL) {
          return approvalResponse(approvalStatus);
        }

        if (target === SCAN_URL) {
          return scanResponse();
        }

        return upstream(TARBALL_BYTES, {
          'content-type': 'application/octet-stream',
        });
      });
    }

    async function requestTarball(): ReturnType<typeof app.inject> {
      return app.inject({
        method: 'GET',
        url: '/npm/lodash/-/lodash-4.17.21.tgz',
      });
    }

    it('registers approvals and forwards when every decision is ACCEPT',
      async () => {
        mockLookup('FOUND', 'ACCEPT');

        const response = await requestTarball();

        expect(response.statusCode).toBe(200);
        expect(approvalCalls()).toHaveLength(1);
        expect(verdaccioCalls()).toHaveLength(1);

        const body = JSON.parse(approvalCalls()[0][1]?.body as string) as {
          requestId: string;
          packages: LookupPackage[];
        };

        expect(body.packages).toEqual([
          { packageName: 'lodash', version: '4.17.21', integrity: 'sha512-root' },
          { packageName: 'dep-a', version: '1.0.0', integrity: 'sha512-a' },
        ]);
      });

    // Plugin이 requestId를 필수로 검증한다.
    // Decision 조회와 같은 값이어야 로그를 이어붙일 수 있다.
    it('reuses the requestId from the Decision lookup', async () => {
      mockLookup('FOUND', 'ACCEPT');

      const response = await requestTarball();

      expect(response.statusCode).toBe(200);

      const lookupBody = JSON.parse(
        lookupCalls()[0][1]?.body as string,
      ) as { requestId: string };
      const approvalBody = JSON.parse(
        approvalCalls()[0][1]?.body as string,
      ) as { requestId: string };

      expect(approvalBody.requestId).toBe(lookupBody.requestId);
      const approvalHeaders = new Headers(approvalCalls()[0][1]?.headers);
      const registryHeaders = new Headers(verdaccioCalls()[0][1]?.headers);
      expect(approvalHeaders.get('x-request-id')).toBe(approvalBody.requestId);
      expect(registryHeaders.get('x-request-id')).toBe(approvalBody.requestId);
      expect(response.headers['x-request-id']).toBe(approvalBody.requestId);
      expect(approvalBody.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    // MVP에서는 REJECT / HOLD / REVIEW를 구분하지 않고 모두 차단한다
    it.each(['REJECT', 'HOLD', 'REVIEW'])(
      'blocks with 403 when a decision is %s',
      async (decision) => {
        mockLookup('FOUND', decision);

        const response = await requestTarball();

        expect(response.statusCode).toBe(403);
        expect(approvalCalls()).toHaveLength(0);
        expect(verdaccioCalls()).toHaveLength(0);
      },
    );

    // Scanner가 판정을 남기지 못한 경우. 통과시키면 미검사 Package가 나간다
    it('blocks with 403 when a package is still NOT_FOUND after the scan',
      async () => {
        process.env.SCANNER_ENABLED = 'true';
        mockLookup('NOT_FOUND');

        const response = await requestTarball();

        expect(response.statusCode).toBe(403);
        expect(approvalCalls()).toHaveLength(0);
        expect(verdaccioCalls()).toHaveLength(0);
      });

    // 등록이 안 되면 Verdaccio Guard가 어차피 막는다.
    // Gateway가 먼저 차단하는 편이 원인이 명확하다
    it('does not forward when approval registration fails', async () => {
      mockLookup('FOUND', 'ACCEPT', 500);

      const response = await requestTarball();

      expect(response.statusCode).toBe(500);
      expect(approvalCalls()).toHaveLength(1);
      expect(verdaccioCalls()).toHaveLength(0);
    });

    it('does not enforce on a metadata request', async () => {
      mockLookup('FOUND', 'REJECT');

      const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(response.statusCode).toBe(200);
      expect(approvalCalls()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // 중복 분석 제거
  //
  // analyze()는 tarball 요청마다 호출되지만, 한 번의 npm install에서 오는
  // tarball들은 모두 같은 의존성 트리에 속한다. 첫 분석이 트리 전체를 확인했으므로
  // 나머지 요청에서 트리를 다시 만들 이유가 없다.
  //
  // 건너뛰는 것은 Arborist 트리 구성 하나뿐이다. Decision 조회와 집행은
  // 요청마다 그대로 수행한다. Decision은 불변이 아니기 때문이다.
  // ---------------------------------------------------------------------

  describe('중복 분석 제거', () => {
    // 조회 응답을 Test 도중에 바꿀 수 있게 해 둔다.
    let currentDecision = 'ACCEPT';
    let currentLookupStatus: 'FOUND' | 'NOT_FOUND' = 'FOUND';

    function mockRegistry(approvalStatus = 200): void {
      fetchMock.mockImplementation(async (url, init) => {
        const target = String(url);

        if (target === LOOKUP_URL) {
          return lookupResponse(init, currentLookupStatus, currentDecision);
        }

        if (target === APPROVAL_URL) {
          return approvalResponse(approvalStatus);
        }

        if (target === SCAN_URL) {
          return scanResponse();
        }

        return upstream(TARBALL_BYTES, {
          'content-type': 'application/octet-stream',
        });
      });
    }

    function requestTarball(
      path = '/npm/lodash/-/lodash-4.17.21.tgz',
    ): ReturnType<typeof app.inject> {
      return app.inject({ method: 'GET', url: path });
    }

    function lookupBodies(): { packages: LookupPackage[] }[] {
      return lookupCalls().map(
        ([, init]) => JSON.parse(init?.body as string) as {
          packages: LookupPackage[];
        },
      );
    }

    beforeEach(() => {
      currentDecision = 'ACCEPT';
      currentLookupStatus = 'FOUND';
      mockRegistry();
    });

    describe('트리 재구성 생략', () => {
      it('두 번째 요청은 트리를 다시 만들지 않는다', async () => {
        await requestTarball();
        const second = await requestTarball();

        expect(second.statusCode).toBe(200);
        expect(arboristMock).toHaveBeenCalledTimes(1);
        expect(verdaccioCalls()).toHaveLength(2);
      });

      // 첫 분석이 트리 전체를 기억하므로 같은 트리의 다른 Package도 통과한다.
      // mock 트리는 요청 Package와 dep-a@1.0.0으로 이루어져 있다.
      it('같은 트리의 다른 Package도 트리 재구성 없이 처리된다', async () => {
        await requestTarball();
        const dependency = await requestTarball('/npm/dep-a/-/dep-a-1.0.0.tgz');

        expect(dependency.statusCode).toBe(200);
        expect(arboristMock).toHaveBeenCalledTimes(1);
      });

      // npm은 tarball을 동시에 여러 개 요청한다(maxsockets 기본 15, 실측).
      // 직렬화와 재확인이 없으면 동시 진입분이 각자 트리를 만든다.
      it('동시 요청 15건이 들어와도 트리는 한 번만 만든다', async () => {
        const responses = await Promise.all(
          Array.from({ length: 15 }, () => requestTarball()),
        );

        for (const response of responses) {
          expect(response.statusCode).toBe(200);
        }

        expect(arboristMock).toHaveBeenCalledTimes(1);
        expect(verdaccioCalls()).toHaveLength(15);
      });

      // Scanner는 NOT_FOUND일 때만 호출된다. 첫 분석이 판정을 남기면
      // 이후 조회는 FOUND가 되어 Scanner 호출이 자연히 사라진다.
      it('Scanner는 첫 분석에서만 호출된다', async () => {
        const originalEnabled = process.env.SCANNER_ENABLED;

        process.env.SCANNER_ENABLED = 'true';
        currentLookupStatus = 'NOT_FOUND';

        try {
          fetchMock.mockImplementation(async (url, init) => {
            const target = String(url);

            if (target === LOOKUP_URL) {
              // 첫 조회만 NOT_FOUND. Scanner가 판정을 남긴 뒤로는 FOUND.
              const status = lookupCalls().length <= 1 ? 'NOT_FOUND' : 'FOUND';

              return lookupResponse(init, status, 'ACCEPT');
            }

            if (target === SCAN_URL) {
              return scanResponse();
            }

            if (target === APPROVAL_URL) {
              return approvalResponse();
            }

            return upstream(TARBALL_BYTES, {
              'content-type': 'application/octet-stream',
            });
          });

          await requestTarball();
          await requestTarball();
          await requestTarball();

          expect(scanCalls()).toHaveLength(1);
          expect(arboristMock).toHaveBeenCalledTimes(1);
        } finally {
          if (originalEnabled === undefined) {
            delete process.env.SCANNER_ENABLED;
          } else {
            process.env.SCANNER_ENABLED = originalEnabled;
          }
        }
      });
    });

    // -------------------------------------------------------------------
    // 여기가 이 기능의 안전 조건이다.
    // 트리를 건너뛰더라도 판정은 매 요청 실시간으로 확인해야 한다.
    // -------------------------------------------------------------------

    describe('판정 재검증', () => {
      it('두 번째 요청도 Decision을 다시 조회한다', async () => {
        await requestTarball();
        await requestTarball();

        expect(lookupCalls()).toHaveLength(2);
      });

      it('재조회는 packageName / version / integrity를 그대로 보낸다', async () => {
        await requestTarball();
        await requestTarball();

        const [, reverify] = lookupBodies();

        expect(reverify.packages).toEqual([
          {
            packageName: 'lodash',
            version: '4.17.21',
            integrity: 'sha512-root',
          },
        ]);
      });

      it('재조회는 요청한 Artifact 하나만 조회한다', async () => {
        await requestTarball();
        await requestTarball();

        const [first, reverify] = lookupBodies();

        // 첫 조회는 트리 전체(root + dep-a)
        expect(first.packages).toHaveLength(2);
        expect(reverify.packages).toHaveLength(1);
      });

      it('판정이 REJECT로 바뀌면 두 번째 요청은 차단된다', async () => {
        const first = await requestTarball();

        currentDecision = 'REJECT';

        const second = await requestTarball();

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(403);
        expect(verdaccioCalls()).toHaveLength(1);
      });

      it('판정 기록이 사라지면 두 번째 요청은 차단된다', async () => {
        const first = await requestTarball();

        currentLookupStatus = 'NOT_FOUND';

        const second = await requestTarball();

        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(403);
      });

      // 판정이 바뀐 Artifact를 계속 기억하면 이후 요청도 단건 조회만 반복한다.
      // 트리 전체를 다시 확인하는 편이 맞다.
      it('재검증에 실패하면 기억에서 지워 다음 요청이 다시 분석한다',
        async () => {
          await requestTarball();

          currentDecision = 'REJECT';
          await requestTarball();

          expect(arboristMock).toHaveBeenCalledTimes(1);

          currentDecision = 'ACCEPT';
          const third = await requestTarball();

          expect(third.statusCode).toBe(200);
          expect(arboristMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('요청 순서', () => {
      // npm이 어떤 tarball을 먼저 요청할지는 보장되지 않는다.
      // 순서가 바뀌면 트리를 만드는 횟수가 달라질 뿐, 집행은 그대로여야 한다.
      it('dependency가 먼저 도착해도 판정은 정상 집행된다', async () => {
        const dependency = await requestTarball('/npm/dep-a/-/dep-a-1.0.0.tgz');
        const root = await requestTarball();

        expect(dependency.statusCode).toBe(200);
        expect(root.statusCode).toBe(200);
        expect(verdaccioCalls()).toHaveLength(2);
      });

      it('dependency가 먼저 오면 root는 자기 트리를 새로 만든다', async () => {
        await requestTarball('/npm/dep-a/-/dep-a-1.0.0.tgz');
        await requestTarball();

        // dep-a 트리에는 lodash가 없으므로 root는 다시 만들어야 한다.
        expect(arboristMock).toHaveBeenCalledTimes(2);
      });

      it('dependency가 먼저 와도 REJECT는 차단된다', async () => {
        await requestTarball('/npm/dep-a/-/dep-a-1.0.0.tgz');

        currentDecision = 'REJECT';

        const root = await requestTarball();

        expect(root.statusCode).toBe(403);
      });
    });

    describe('통과하지 못한 요청', () => {
      it('차단된 Package는 기억되지 않아 다시 분석된다', async () => {
        currentDecision = 'REJECT';

        const first = await requestTarball();
        const second = await requestTarball();

        expect(first.statusCode).toBe(403);
        expect(second.statusCode).toBe(403);
        expect(arboristMock).toHaveBeenCalledTimes(2);
        expect(approvalCalls()).toHaveLength(0);
        expect(verdaccioCalls()).toHaveLength(0);
      });

      it('승인 등록에 실패하면 기억되지 않아 다시 분석한다', async () => {
        mockRegistry(500);

        const first = await requestTarball();
        const second = await requestTarball();

        expect(first.statusCode).toBe(500);
        expect(second.statusCode).toBe(500);
        expect(arboristMock).toHaveBeenCalledTimes(2);
        expect(approvalCalls()).toHaveLength(2);
        expect(verdaccioCalls()).toHaveLength(0);
      });
    });
  });

  describe('종료된 로그인 경로', () => {
    it.each([
      ['PUT', '/npm/-/user/org.couchdb.user:admin'],
      ['PUT', '/npm/-/user/org.couchdb.user:admin/-rev/3-abc'],
      ['GET', '/npm/-/user/org.couchdb.user:admin'],
    ] as const)('does not forward %s %s', async (method, url) => {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(410);
      expect(response.json().message).toContain('Dashboard');
      expect(verdaccioCalls()).toHaveLength(0);
    });
  });

  // /npm/-/* 를 통째로 중계하면 Verdaccio 내부 전용 API가 외부로 노출된다
  describe('내부 경로 차단', () => {
    it.each([
      ['GET', '/npm/-/whs/approvals'],
      ['POST', '/npm/-/whs/approvals'],
      ['GET', '/npm/-/whoami'],
      ['DELETE', '/npm/-/user/token/abc123'],
    ])('does not forward %s %s', async (method, url) => {
      const response = await app.inject({ method: method as 'GET', url });

      expect(response.statusCode).toBe(404);
      expect(verdaccioCalls()).toHaveLength(0);
    });
  });

  describe('공통', () => {
    it.each([
      ['GET', '/npm/lodash'],
      ['GET', '/npm/lodash/-/lodash-4.17.21.tgz'],
    ] as const)('overwrites client tracing headers for %s %s', async (method, url) => {
      const response = await app.inject({
        method,
        url,
        remoteAddress: '192.0.2.10',
        headers: {
          'x-request-id': 'client-request-id',
          'x-forwarded-for': '198.51.100.20, 198.51.100.21',
          authorization: 'Bearer test-user-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(verdaccioCalls()).toHaveLength(1);
      const headers = new Headers(verdaccioCalls()[0][1]?.headers);
      expect(headers.get('x-request-id')).toBe(response.headers['x-request-id']);
      expect(headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(headers.get('x-forwarded-for')).toBe('192.0.2.10');
      expect(headers.get('authorization')).toBe(`Basic ${Buffer.from('gateway-reader:test-only-password').toString('base64')}`);
    });

    it.each(['192.0.2.10', '2001:db8::10'])(
      'adds tracing headers from the connection address %s',
      async (remoteAddress) => {
        const response = await app.inject({
          method: 'GET',
          url: '/npm/lodash',
          remoteAddress,
        });

        expect(response.statusCode).toBe(200);
        const headers = new Headers(verdaccioCalls()[0][1]?.headers);
        expect(headers.get('x-request-id')).toBe(response.headers['x-request-id']);
        expect(headers.get('x-request-id')).toBeTruthy();
        expect(headers.get('x-forwarded-for')).toBe(remoteAddress);
      },
    );

    it.each([200, 403])(
      'preserves the Gateway requestId when Verdaccio returns %i with another ID',
      async (status) => {
        fetchMock.mockImplementation(async () => upstream('response', {
          'x-request-id': 'upstream-request-id',
        }, status));

        const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

        expect(response.statusCode).toBe(status);
        const headers = new Headers(verdaccioCalls()[0][1]?.headers);
        expect(response.headers['x-request-id']).toBe(headers.get('x-request-id'));
        expect(response.headers['x-request-id']).not.toBe('upstream-request-id');
      },
    );

    it('forwards the Authorization header', async () => {
      await app.inject({
        method: 'GET',
        url: '/npm/lodash',
        headers: { authorization: 'Bearer npm-token' },
      });

      const headers = verdaccioCalls()[0][1]?.headers as Record<string, string>;

      expect(headers.authorization).toBe(`Basic ${Buffer.from('gateway-reader:test-only-password').toString('base64')}`);
    });

    it('does not forward the host header', async () => {
      await app.inject({ method: 'GET', url: '/npm/lodash' });

      const headers = verdaccioCalls()[0][1]?.headers as Record<string, string>;

      expect(headers).not.toHaveProperty('host');
    });

    it('passes through an upstream 404', async () => {
      fetchMock.mockImplementation(async () => upstream('not found', {}, 404));

      const response = await app.inject({ method: 'GET', url: '/npm/missing' });

      expect(response.statusCode).toBe(404);
    });

    it('returns an internal error when Verdaccio is unreachable', async () => {
      fetchMock.mockImplementation(async (url) => {
        if (String(url).startsWith(VERDACCIO)) {
          throw new Error('ECONNREFUSED');
        }

        return upstream(PACKUMENT, {});
      });

      const response = await app.inject({ method: 'GET', url: '/npm/lodash' });

      expect(response.statusCode).toBe(500);
      expect(response.json().code).toBe('GATEWAY_INTERNAL_ERROR');
      expect(response.payload).not.toContain('verdaccio');
    });

    it.each([
      '/npm/React',
      '/npm/.hidden',
      '/npm/_private',
    ])('rejects %s without forwarding', async (url) => {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(400);
      expect(verdaccioCalls()).toHaveLength(0);
    });

    // npm은 요청을 병렬로 보낸다. 순차 처리 구조가 아님을 확인한다.
    it('handles concurrent requests', async () => {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/npm/lodash' }),
        app.inject({ method: 'GET', url: '/npm/@babel/core' }),
        app.inject({ method: 'GET', url: '/npm/lodash/-/lodash-4.17.21.tgz' }),
        app.inject({ method: 'GET', url: '/npm/dep-a/-/dep-a-1.0.0.tgz' }),
      ]);

      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
      expect(verdaccioCalls()).toHaveLength(4);
    });

    it('keeps the existing health endpoint unchanged', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', service: 'gateway' });
    });
  });
});
