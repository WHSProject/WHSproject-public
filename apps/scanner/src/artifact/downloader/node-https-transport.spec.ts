import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { Readable } from 'node:stream';

import { validateTarballTarget } from '../../registry/tarball-url-validator/tarball-url-validator';
import {
  NodeHttpsTransport,
  type HttpsRequestFactory,
} from './node-https-transport';

describe('NodeHttpsTransport', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('performs a bodyless pinned HTTPS GET without weakening TLS', async () => {
    const request = new FakeClientRequest();
    let capturedOptions: RequestOptions | undefined;
    const requestFactory: HttpsRequestFactory = (options, listener) => {
      capturedOptions = options;
      queueMicrotask(() => listener(incomingResponse()));
      return request as unknown as ClientRequest;
    };
    const target = await validatedTarget();
    const transport = new NodeHttpsTransport(requestFactory);

    await transport.request({
      connectTimeoutMs: 50,
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'whs-scanner/test',
      },
      signal: new AbortController().signal,
      target,
    });

    expect(capturedOptions).toMatchObject({
      agent: false,
      headers: {
        Accept: 'application/octet-stream',
        'Accept-Encoding': 'identity',
        'User-Agent': 'whs-scanner/test',
      },
      hostname: 'registry.npmjs.org',
      lookup: target.connection.lookup,
      method: 'GET',
      path: '/package.tgz?download=1',
      port: 443,
      protocol: 'https:',
      rejectUnauthorized: true,
      servername: 'registry.npmjs.org',
    });
    expect(capturedOptions).not.toHaveProperty('auth');
    expect(capturedOptions?.headers).not.toHaveProperty('Cookie');
    expect(capturedOptions).not.toHaveProperty('redirect');
    expect(request.end).toHaveBeenCalledWith();
  });

  it('destroys a request when the connect timeout expires', async () => {
    jest.useFakeTimers();
    const request = new FakeClientRequest();
    const transport = new NodeHttpsTransport(
      (() => request as unknown as ClientRequest) as HttpsRequestFactory,
    );
    const promise = transport.request({
      connectTimeoutMs: 5,
      headers: {},
      signal: new AbortController().signal,
      target: await validatedTarget(),
    });
    const rejection = expect(promise).rejects.toMatchObject({
      code: 'ETIMEDOUT',
    });

    await jest.advanceTimersByTimeAsync(5);

    await rejection;
    expect(request.destroy).toHaveBeenCalledTimes(1);
  });

  it('clears the connect timeout after the TLS connection is established', async () => {
    jest.useFakeTimers();
    const request = new FakeClientRequest();
    const socket = new EventEmitter();
    let respond: ((response: IncomingMessage) => void) | undefined;
    const transport = new NodeHttpsTransport(((_options, listener) => {
      respond = listener;
      return request as unknown as ClientRequest;
    }) as HttpsRequestFactory);
    const promise = transport.request({
      connectTimeoutMs: 5,
      headers: {},
      signal: new AbortController().signal,
      target: await validatedTarget(),
    });

    request.emit('socket', socket);
    socket.emit('secureConnect');
    await jest.advanceTimersByTimeAsync(10);

    expect(request.destroy).not.toHaveBeenCalled();
    if (respond === undefined) {
      throw new Error('Expected HTTPS response listener');
    }
    respond(incomingResponse());
    await expect(promise).resolves.toBeDefined();
  });
});

class FakeClientRequest extends EventEmitter {
  readonly end = jest.fn();
  readonly destroy = jest.fn((error?: Error) => {
    if (error !== undefined) {
      this.emit('error', error);
    }
    return this;
  });
}

async function validatedTarget() {
  return validateTarballTarget(
    'https://registry.npmjs.org/package.tgz?download=1',
    async () => [{ address: '104.16.24.34', family: 4 }],
  );
}

function incomingResponse(): IncomingMessage {
  return Object.assign(Readable.from([]), {
    complete: true,
    headers: {},
    statusCode: 200,
  }) as IncomingMessage;
}
