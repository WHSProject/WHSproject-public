import { Injectable } from '@nestjs/common';

import {
  resolveScannerBaseUrl,
  resolveScannerTimeoutMs,
} from '../config/scanner.config';
import type { ScannerRequestDto } from '../dto/scanner-request.dto';
import { ScannerRequestError } from '../errors/scanner.errors';

// Scanner가 제공하는 분석 요청 경로.
const SCAN_PATH = '/internal/v1/scans';

// 분석 완료 상태. 200만 허용한다.
// 202(접수, 처리 중)를 완료로 보면 분석 전에 Package가 전달되므로 막아야 하고,
// Nest @Post() 기본값 201도 같은 이유로 거부한다(Scanner는 @HttpCode(200) 반환).
const COMPLETED_STATUS = 200;

@Injectable()
export class ScannerClient {
  // 미판정 Package 전체를 한 번에 분석 의뢰한다. 성공은 HTTP 상태로만 판단한다.
  //
  // fetch는 응답 헤더 수신 시점에 resolve한다(실측). "분석이 끝난 뒤 응답"은
  // Scanner가 Decision 저장 후 헤더를 보낸다는 계약으로만 보장된다.
  // 본문은 읽지 않는다. 분석 결과는 이후 Decision 재조회로 확인한다.
  async scan(request: ScannerRequestDto): Promise<void> {
    const url = `${resolveScannerBaseUrl()}${SCAN_PATH}`;

    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        // 분석이 끝날 때까지 기다리되, npm이 먼저 끊기 전에 정리한다
        signal: AbortSignal.timeout(resolveScannerTimeoutMs()),
      });
    } catch (error) {
      throw new ScannerRequestError('scan request failed', null, error);
    }

    // 본문을 쓰지 않으므로 연결 재사용을 위해 정리한다.
    // 끊긴 연결에서는 cancel이 reject하며(실측), 처리하지 않으면 unhandled rejection으로 프로세스가 종료된다.
    response.body?.cancel().catch(() => undefined);

    if (response.status !== COMPLETED_STATUS) {
      throw new ScannerRequestError(
        `scan request failed with status ${response.status}`,
        response.status,
      );
    }
  }
}
