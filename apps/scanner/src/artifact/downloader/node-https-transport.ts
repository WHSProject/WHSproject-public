import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  request as httpsRequest,
  type RequestOptions,
} from 'node:https';
import type { ClientRequest } from 'node:http';
import type { TLSSocket } from 'node:tls';

import type { ValidatedTarballTarget } from '../../registry/tarball-url-validator/tarball-url-validator';
import {
  TarballConnectTimeoutError,
  TarballNetworkError,
} from './tarball-download.error';

export interface TarballHttpResponse {
  body: IncomingMessage;
  headers: IncomingHttpHeaders;
  isComplete: () => boolean;
  statusCode: number;
}

export interface TarballTransportRequest {
  connectTimeoutMs: number;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
  target: ValidatedTarballTarget;
}

export interface TarballHttpTransport {
  request(options: TarballTransportRequest): Promise<TarballHttpResponse>;
}

export type HttpsRequestFactory = (
  options: RequestOptions,
  responseListener: (response: IncomingMessage) => void,
) => ClientRequest;

export class NodeHttpsTransport implements TarballHttpTransport {
  constructor(
    private readonly requestFactory: HttpsRequestFactory = httpsRequest,
  ) {}

  request(options: TarballTransportRequest): Promise<TarballHttpResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;

      const clearConnectTimer = (): void => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
      };

      const request = this.requestFactory(
        {
          agent: false,
          headers: options.headers,
          hostname: options.target.connection.hostname,
          lookup: options.target.connection.lookup,
          method: 'GET',
          path: `${options.target.url.pathname}${options.target.url.search}`,
          port: options.target.connection.port,
          protocol: 'https:',
          rejectUnauthorized: true,
          servername: options.target.connection.servername,
          signal: options.signal,
        },
        (response) => {
          clearConnectTimer();
          settled = true;
          resolve({
            body: response,
            headers: response.headers,
            isComplete: () => response.complete,
            statusCode: response.statusCode ?? 0,
          });
        },
      );

      connectTimer = setTimeout(() => {
        request.destroy(new TarballConnectTimeoutError());
      }, options.connectTimeoutMs);

      request.once('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', clearConnectTimer);
      });
      request.once('error', (error) => {
        clearConnectTimer();
        if (!settled) {
          settled = true;
          reject(new TarballNetworkError(error));
        }
      });

      request.end();
    });
  }
}
