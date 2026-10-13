import type { ScannerEnvironment } from '../config/scanner-environment';
import { ScannerErrorCode } from '../domain/scanner-error-code';
import {
  PolicyEvaluationClient,
  PolicyEvaluationError,
  type PolicyEvaluationRequest,
} from './policy-evaluation.client';
import type { OsvFeedResult } from '../osv/osv-feed.types';

const environment: ScannerEnvironment = {
  POLICY_URL: 'http://policy:8000',
  POLICY_TIMEOUT_MS: 1000,
  SCANNER_PACKAGE_TIMEOUT_MS: 30_000,
  OBFUSCATION_GPT_MODE: 'off',
  METADATA_TIMEOUT_MS: 1000,
  METADATA_MAX_RESPONSE_BYTES: 2_097_152,
  TARBALL_CONNECT_TIMEOUT_MS: 1000,
  TARBALL_DOWNLOAD_TIMEOUT_MS: 1000,
  MAX_TARBALL_BYTES: 1024,
  TARBALL_MAX_REDIRECTS: 3,
};

function osvFeed(
  feedStatus: OsvFeedResult['feedStatus'] = 'SUCCESS',
  advisories: Record<string, unknown>[] = [],
): OsvFeedResult {
  return {
    source: 'OSV',
    feedStatus,
    query: { ecosystem: 'npm', packageName: 'example', packageVersion: '1.0.0' },
    advisories,
    complete: feedStatus === 'SUCCESS',
    pagesFetched: feedStatus === 'SUCCESS' ? 1 : 0,
    collectedAt: feedStatus === 'SKIPPED' ? null : '2026-09-17T00:00:00.000Z',
    completedAt: feedStatus === 'SUCCESS' ? '2026-09-17T00:00:01.000Z' : null,
    errorCode: feedStatus === 'FAILED'
      ? 'NETWORK_ERROR'
      : feedStatus === 'TIMEOUT' ? 'PARENT_ABORTED' : null,
    skippedReason: feedStatus === 'SKIPPED' ? 'PROVENANCE_UNCONFIRMED' : null,
  };
}

const request: PolicyEvaluationRequest = {
  requestId: 'request-1',
  scanStatus: 'COMPLETED',
  scanId: 'scan-1',
  subject: {
    ecosystem: 'npm',
    packageName: 'example',
    packageVersion: '1.0.0',
    artifactHash: 'a'.repeat(64),
    integrity: 'sha512-' + 'A'.repeat(88),
  },
  evidences: [{
    subject: {
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'a'.repeat(64),
    },
  }],
  osvFeed: osvFeed('SUCCESS', [{ id: 'OSV-2026-1' }]),
};

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(body === undefined ? {} : { json: jest.fn().mockResolvedValue(body) }),
  } as unknown as Response;
}

describe('PolicyEvaluationClient', () => {
  const fetch = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => fetch.mockReset());

  it('sends the policy evaluation request successfully', async () => {
    fetch.mockResolvedValue(response(200, {
      persistence: { saved: true, status: 'SAVED', decisionDbId: null },
    }));

    await expect(new PolicyEvaluationClient(environment).evaluate(request)).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith(
      'http://policy:8000/internal/v1/evaluations',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    );
    const [, options] = fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(options.body as string)).toEqual(expect.objectContaining({
      subject: expect.objectContaining({
        artifactHash: 'a'.repeat(64),
        integrity: 'sha512-' + 'A'.repeat(88),
      }),
    }));
    expect(JSON.parse(options.body as string).evidences[0].subject)
      .not.toHaveProperty('integrity');
    expect(JSON.parse(options.body as string)).toMatchObject({
      osvFeed: {
        feedStatus: 'SUCCESS',
        advisories: [{ id: 'OSV-2026-1' }],
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['SUCCESS with no advisories', osvFeed('SUCCESS')],
    ['FAILED', osvFeed('FAILED')],
    ['TIMEOUT', osvFeed('TIMEOUT')],
    ['SKIPPED', osvFeed('SKIPPED')],
  ])('sends the %s OSV result in the existing evaluation request', async (_case, result) => {
    fetch.mockResolvedValue(response(200, {
      persistence: { saved: true, status: 'SAVED', decisionDbId: null },
    }));

    await new PolicyEvaluationClient(environment).evaluate({
      ...request,
      osvFeed: result,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://policy:8000/internal/v1/evaluations',
      expect.objectContaining({
        body: JSON.stringify({ ...request, osvFeed: result }),
      }),
    );
  });

  it('accepts ALREADY_EXISTS persistence as success', async () => {
    fetch.mockResolvedValue(response(200, {
      persistence: { saved: true, status: 'ALREADY_EXISTS', decisionDbId: null },
    }));

    await expect(new PolicyEvaluationClient(environment).evaluate(request)).resolves.toBeUndefined();
  });

  it.each([
    ['missing', {}],
    ['null', { persistence: null }],
    ['saved false', { persistence: { saved: false, status: 'SAVED', decisionDbId: null } }],
    ['invalid status', { persistence: { saved: true, status: 'UNKNOWN', decisionDbId: null } }],
  ])('rejects %s persistence', async (_case, body) => {
    fetch.mockResolvedValue(response(200, body));

    await expect(new PolicyEvaluationClient(environment).evaluate(request))
      .rejects.toMatchObject({
        code: ScannerErrorCode.POLICY_EVALUATION_FAILED,
        retryable: false,
        statusCode: 200,
      });
  });

  it('rejects an invalid JSON success response', async () => {
    fetch.mockResolvedValue({
      ...response(200),
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
    } as Response);

    await expect(new PolicyEvaluationClient(environment).evaluate(request))
      .rejects.toMatchObject({
        code: ScannerErrorCode.POLICY_EVALUATION_FAILED,
        retryable: false,
        statusCode: 200,
      });
  });

  it('maps timeout failures to POLICY_EVALUATION_TIMEOUT', async () => {
    const error = new DOMException('timed out', 'TimeoutError');
    fetch.mockRejectedValue(error);

    await expect(new PolicyEvaluationClient(environment).evaluate(request))
      .rejects.toMatchObject({
        code: ScannerErrorCode.POLICY_EVALUATION_TIMEOUT,
        retryable: true,
        statusCode: null,
      });
  });

  it('maps network failures to POLICY_EVALUATION_FAILED', async () => {
    fetch.mockRejectedValue(new TypeError('fetch failed'));

    await expect(new PolicyEvaluationClient(environment).evaluate(request))
      .rejects.toMatchObject({
        code: ScannerErrorCode.POLICY_EVALUATION_FAILED,
        retryable: true,
        statusCode: null,
      });
  });

  it.each([
    [400, false],
    [500, true],
  ])('maps HTTP %s to POLICY_EVALUATION_FAILED', async (status, retryable) => {
    fetch.mockResolvedValue(response(status));

    await expect(new PolicyEvaluationClient(environment).evaluate(request))
      .rejects.toMatchObject({
        code: ScannerErrorCode.POLICY_EVALUATION_FAILED,
        retryable,
        statusCode: status,
      } satisfies Partial<PolicyEvaluationError>);
  });
});
