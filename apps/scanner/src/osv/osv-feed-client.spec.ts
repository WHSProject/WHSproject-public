import { OsvConcurrencyLimiter, OsvFeedClient, OSV_QUERY_ENDPOINT } from './osv-feed-client';
import type { OsvFeedInput, OsvTransport } from './osv-feed.types';

const input = (): OsvFeedInput => ({ ecosystem: 'npm', packageName: '@scope/example', packageVersion: '1.2.3', permission: { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' }, remainingMs: 30_000, signal: new AbortController().signal });
const advisory = { id: 'TEST', affected: [{ arbitrary: true }], withdrawn: 'unvalidated', severity: [{ score: 'unvalidated' }] };
const response = (text: string, status = 200) => ({ status, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(text)); c.close(); } }) });
function transport(...pages: unknown[]): jest.MockedFunction<OsvTransport> {
  const mock: jest.MockedFunction<OsvTransport> = jest.fn();
  for (const page of pages) mock.mockImplementationOnce(async () => response(JSON.stringify(page)));
  return mock;
}

it.each([{ vulns: [advisory] }, { vulns: [] }, {}])('returns complete SUCCESS for %j', async page => {
  const mock = transport(page);
  const result = await new OsvFeedClient({}, mock).query(input());
  expect(result).toEqual({ source: 'OSV', feedStatus: 'SUCCESS', query: { ecosystem: 'npm', packageName: '@scope/example', packageVersion: '1.2.3' }, advisories: 'vulns' in page ? page.vulns : [], complete: true, pagesFetched: 1, collectedAt: expect.any(String), completedAt: expect.any(String), errorCode: null, skippedReason: null });
  expect(Date.parse(result.completedAt!)).toBeGreaterThanOrEqual(Date.parse(result.collectedAt!));
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledWith(OSV_QUERY_ENDPOINT, { method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ package: { ecosystem: 'npm', name: '@scope/example' }, version: '1.2.3' }), signal: expect.any(AbortSignal) });
});
it('collects token-only and advisory pages without altering raw records', async () => {
  const mock = transport({ next_page_token: 'a' }, { vulns: [advisory], next_page_token: 'b' }, { vulns: [advisory] });
  expect(await new OsvFeedClient({}, mock).query(input())).toMatchObject({ feedStatus: 'SUCCESS', pagesFetched: 3, advisories: [advisory, advisory] });
  expect(mock.mock.calls.map(([, o]) => JSON.parse(o.body).page_token)).toEqual([undefined, 'a', 'b']);
  expect(new Set(mock.mock.calls.map(([, o]) => o.signal)).size).toBe(1);
});
it.each([301, 302, 307, 308, 400, 429, 500, 503])('fails HTTP %i without retry or redirect', async status => {
  const cancel = jest.fn();
  const mock: jest.MockedFunction<OsvTransport> = jest.fn<ReturnType<OsvTransport>, Parameters<OsvTransport>>(async () => ({ status, body: new ReadableStream({ cancel }) }));
  expect(await new OsvFeedClient({}, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'HTTP_ERROR', advisories: [], complete: false, completedAt: null });
  expect(mock).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('fails network errors without retry', async () => {
  const mock: jest.MockedFunction<OsvTransport> = jest.fn<ReturnType<OsvTransport>, Parameters<OsvTransport>>(async () => { throw new Error('ECONNRESET'); });
  expect(await new OsvFeedClient({}, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'NETWORK_ERROR', advisories: [], completedAt: null });
  expect(mock).toHaveBeenCalledTimes(1);
});

it('coalesces concurrent real-time lookups for the same package identity', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const mock = jest.fn(async () => {
    await gate;
    return response(JSON.stringify({ vulns: [] }));
  });
  const client = new OsvFeedClient({}, mock);
  const first = client.query(input());
  const second = client.query(input());
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(mock).toHaveBeenCalledTimes(1);
  release();
  await expect(Promise.all([first, second])).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ feedStatus: 'SUCCESS' })]));
});

it('limits concurrent page requests with the shared coordinator', async () => {
  let active = 0;
  let peak = 0;
  const mock = jest.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(JSON.stringify({ vulns: [] }));
  });
  const limiter = new OsvConcurrencyLimiter(1);
  const client = new OsvFeedClient({}, mock, limiter);
  await Promise.all([
    client.query(input()),
    client.query({ ...input(), packageName: '@scope/other' }),
  ]);
  expect(peak).toBe(1);
});
it.each(['{bad', '', '{"vulns":'])('rejects malformed JSON %s', async text => {
  expect(await new OsvFeedClient({}, async () => response(text)).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'INVALID_JSON', completedAt: null });
});
it.each([null, [], { vulns: null }, { vulns: [null] }, { next_page_token: 123 }])('rejects malformed envelope %j', async page => {
  expect(await new OsvFeedClient({}, transport(page)).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'INVALID_RESPONSE', completedAt: null });
});
it.each([
  [{ maxPageBytes: 4 }, 'RESPONSE_TOO_LARGE', { vulns: [] }],
  [{ maxJsonDepth: 2 }, 'JSON_TOO_DEEP', { vulns: [advisory] }],
  [{ maxJsonStringLength: 8 }, 'JSON_STRING_TOO_LONG', { vulns: [{ details: 'a'.repeat(9) }] }],
] as const)('enforces %j', async (limits, errorCode, page) => {
  expect(await new OsvFeedClient(limits, transport(page)).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode, advisories: [], completedAt: null });
});
it('counts cumulative response bytes across pages', async () => {
  const first = { vulns: [advisory], next_page_token: 'a' }, second = { vulns: [advisory] };
  const total = Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second));
  const mock = transport(first, second);
  expect(await new OsvFeedClient({ maxTotalBytes: total - 1 }, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'TOTAL_RESPONSE_TOO_LARGE', advisories: [], pagesFetched: 1, completedAt: null });
  expect(mock).toHaveBeenCalledTimes(2);
});
it.each([[1, 'PAGE_LIMIT_EXCEEDED', 1], [10, 'REPEATED_PAGE_TOKEN', 2]] as const)('stops pagination at %i', async (maxPages, errorCode, calls) => {
  const page = { vulns: [advisory], next_page_token: 'same' }, mock = transport(page, page);
  expect(await new OsvFeedClient({ maxPages }, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode, advisories: [], completedAt: null });
  expect(mock).toHaveBeenCalledTimes(calls);
});
it('discards partial advisories on later HTTP failure', async () => {
  const mock = transport({ vulns: [advisory], next_page_token: 'a' });
  mock.mockImplementationOnce(async () => response('{}', 503));
  expect(await new OsvFeedClient({}, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', pagesFetched: 1, advisories: [], completedAt: null });
  expect(mock).toHaveBeenCalledTimes(2);
});
it.each(['DISABLED', 'UNSUPPORTED_TARGET', 'PRIVATE_PACKAGE', 'PROVENANCE_UNCONFIRMED'] as const)('skips %s without HTTP', async reason => {
  const mock = transport();
  expect(await new OsvFeedClient({}, mock).query({ ...input(), permission: { allowed: false, reason } })).toMatchObject({ feedStatus: 'SKIPPED', skippedReason: reason, collectedAt: null, completedAt: null, advisories: [], complete: false });
  expect(mock).not.toHaveBeenCalled();
});
it.each([{ packageName: '' }, { packageName: ' bad ' }, { packageVersion: '^1.0.0' }, { packageVersion: '' }])('skips invalid identity %j', async patch => {
  const mock = transport();
  expect(await new OsvFeedClient({}, mock).query({ ...input(), ...patch })).toMatchObject({ feedStatus: 'SKIPPED', skippedReason: 'INVALID_PACKAGE_IDENTITY', completedAt: null });
  expect(mock).not.toHaveBeenCalled();
});
it.each([0, -1])('does not start with exhausted budget %i', async remainingMs => {
  const mock = transport();
  expect(await new OsvFeedClient({}, mock).query({ ...input(), remainingMs })).toMatchObject({ feedStatus: 'TIMEOUT', errorCode: 'SCAN_BUDGET_EXHAUSTED', collectedAt: null, completedAt: null });
  expect(mock).not.toHaveBeenCalled();
});
it('does not start when already aborted', async () => {
  const mock = transport();
  expect(await new OsvFeedClient({}, mock).query({ ...input(), signal: AbortSignal.abort() })).toMatchObject({ feedStatus: 'TIMEOUT', errorCode: 'PARENT_ABORTED', collectedAt: null, completedAt: null });
  expect(mock).not.toHaveBeenCalled();
});
it.each([2_000, 35])('bounds hanging transport by %i ms', async remainingMs => {
  jest.useFakeTimers();
  try {
    const mock: jest.MockedFunction<OsvTransport> = jest.fn<ReturnType<OsvTransport>, Parameters<OsvTransport>>(() => new Promise(() => undefined));
    const pending = new OsvFeedClient({ timeoutMs: 9_000 }, mock).query({ ...input(), remainingMs });
    await jest.advanceTimersByTimeAsync(remainingMs);
    expect(await pending).toMatchObject({ feedStatus: 'TIMEOUT', errorCode: 'DEADLINE_EXCEEDED', advisories: [], completedAt: null });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
it('cancels hanging transport promptly', async () => {
  const parent = new AbortController(), mock: jest.MockedFunction<OsvTransport> = jest.fn<ReturnType<OsvTransport>, Parameters<OsvTransport>>(() => new Promise(() => undefined));
  const pending = new OsvFeedClient({}, mock).query({ ...input(), signal: parent.signal });
  parent.abort();
  expect(await pending).toMatchObject({ feedStatus: 'TIMEOUT', errorCode: 'PARENT_ABORTED', completedAt: null });
  expect(mock.mock.calls[0]![1].signal.aborted).toBe(true);
});
it.each(['timeout', 'size', 'abort'] as const)('stops during body streaming on %s', async mode => {
  jest.useFakeTimers();
  try {
    const cancel = jest.fn(), parent = new AbortController();
    const mock: OsvTransport = async () => ({ status: 200, body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('12345')); }, cancel }) });
    const pending = new OsvFeedClient({ maxPageBytes: mode === 'size' ? 4 : 100 }, mock).query({ ...input(), signal: parent.signal });
    await jest.advanceTimersByTimeAsync(0);
    if (mode === 'abort') parent.abort();
    if (mode === 'timeout') await jest.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ feedStatus: mode === 'size' ? 'FAILED' : 'TIMEOUT', errorCode: mode === 'size' ? 'RESPONSE_TOO_LARGE' : mode === 'abort' ? 'PARENT_ABORTED' : 'DEADLINE_EXCEEDED', advisories: [], completedAt: null });
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
it('shares deadline through subsequent page body reads', async () => {
  jest.useFakeTimers();
  try {
    const mock = transport({ vulns: [advisory], next_page_token: 'a' });
    mock.mockImplementationOnce(async () => ({ status: 200, body: new ReadableStream() }));
    const pending = new OsvFeedClient({}, mock).query(input());
    await jest.advanceTimersByTimeAsync(2_000);
    expect(await pending).toMatchObject({ feedStatus: 'TIMEOUT', advisories: [], pagesFetched: 1, completedAt: null });
    expect(mock).toHaveBeenCalledTimes(2);
  } finally { jest.useRealTimers(); }
});
it('enforces JSON string limit across chunks before body completion', async () => {
  const cancel = jest.fn();
  const mock: OsvTransport = async () => ({ status: 200, body: new ReadableStream({ start(c) {
    for (const s of ['{"vulns":[{"details":"', '\\u00', '61'.repeat(10)]) c.enqueue(Buffer.from(s));
  }, cancel }) });
  expect(await new OsvFeedClient({ maxJsonStringLength: 10 }, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'JSON_STRING_TOO_LONG' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('handles split UTF-8, escapes and braces in strings', async () => {
  const page = { vulns: [{ details: '한글 { [ \\" test' }] };
  const mock: OsvTransport = async () => ({ status: 200, body: new ReadableStream({ start(c) {
    for (const byte of Buffer.from(JSON.stringify(page))) c.enqueue(Uint8Array.of(byte));
    c.close();
  } }) });
  expect(await new OsvFeedClient({ maxJsonDepth: 3 }, mock).query(input())).toMatchObject({ feedStatus: 'SUCCESS', advisories: page.vulns });
});
it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid configuration %s', maxPages => {
  expect(() => new OsvFeedClient({ maxPages }, transport())).toThrow(TypeError);
});
it.each([
  [{ ecosystem: 'PyPI' }, 'UNSUPPORTED_TARGET'],
  [{ permission: undefined }, 'PROVENANCE_UNCONFIRMED'],
  [{ permission: { allowed: true, basis: 'USER_INPUT' } }, 'PROVENANCE_UNCONFIRMED'],
  [{ remainingMs: NaN }, 'INVALID_SCAN_BUDGET'],
] as const)('fails closed for %j', async (patch, skippedReason) => {
  const mock = transport();
  expect(await new OsvFeedClient({}, mock).query({ ...input(), ...patch } as OsvFeedInput)).toMatchObject({ feedStatus: 'SKIPPED', skippedReason, collectedAt: null, completedAt: null });
  expect(mock).not.toHaveBeenCalled();
});
it('cancels a late transport response without starting a later page', async () => {
  const parent = new AbortController(), cancel = jest.fn();
  let resolve!: (value: Awaited<ReturnType<OsvTransport>>) => void;
  const mock: jest.MockedFunction<OsvTransport> = jest.fn<ReturnType<OsvTransport>, Parameters<OsvTransport>>(() => new Promise(r => { resolve = r; }));
  const pending = new OsvFeedClient({}, mock).query({ ...input(), signal: parent.signal });
  parent.abort();
  const result = await pending;
  resolve({ status: 200, body: new ReadableStream({ cancel }) });
  await Promise.resolve();
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(mock).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ feedStatus: 'TIMEOUT', pagesFetched: 0, advisories: [], completedAt: null });
});
it('rejects nesting during streaming without awaiting the rest of the body', async () => {
  const cancel = jest.fn();
  const mock: OsvTransport = async () => ({ status: 200, body: new ReadableStream({ start(c) {
    for (const s of ['{"vulns":', '[', '{']) c.enqueue(Buffer.from(s));
  }, cancel }) });
  expect(await new OsvFeedClient({ maxJsonDepth: 2 }, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: 'JSON_TOO_DEEP' });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it('accepts exact byte and depth boundaries', async () => {
  const page = { vulns: [{}] }, bytes = Buffer.byteLength(JSON.stringify(page));
  expect(await new OsvFeedClient({ maxPageBytes: bytes, maxTotalBytes: bytes, maxJsonDepth: 3, maxJsonStringLength: 5 }, transport(page)).query(input())).toMatchObject({ feedStatus: 'SUCCESS' });
});
it('maps invalid UTF-8 and stream errors without partial results', async () => {
  for (const invalidUtf8 of [true, false]) {
    const mock: OsvTransport = async () => ({ status: 200, body: new ReadableStream({ start(c) {
      if (invalidUtf8) { c.enqueue(Uint8Array.of(255)); c.close(); }
      else c.error(new Error('connection lost'));
    } }) });
    expect(await new OsvFeedClient({}, mock).query(input())).toMatchObject({ feedStatus: 'FAILED', errorCode: invalidUtf8 ? 'INVALID_JSON' : 'NETWORK_ERROR', advisories: [], completedAt: null });
  }
});
it('does not reset the timer after a slow first page', async () => {
  jest.useFakeTimers();
  try {
    const mock: jest.MockedFunction<OsvTransport> = jest.fn();
    mock.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve(response(JSON.stringify({ vulns: [advisory], next_page_token: 'a' }))), 1500);
    }));
    mock.mockImplementationOnce(async () => ({ status: 200, body: new ReadableStream() }));
    const pending = new OsvFeedClient({}, mock).query(input());
    await jest.advanceTimersByTimeAsync(1500);
    expect(mock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ feedStatus: 'TIMEOUT', errorCode: 'DEADLINE_EXCEEDED', pagesFetched: 1, advisories: [], completedAt: null });
  } finally { jest.useRealTimers(); }
});
