import { Injectable } from '@nestjs/common';

import {
  resolveDecisionDbBaseUrl,
  resolveDecisionDbTimeoutMs,
} from '../config/decision-db.config';
import type { DecisionLookupRequestDto } from '../dto/decision-lookup.dto';
import {
  DecisionLookupInvalidResponseError,
  DecisionLookupRequestError,
} from '../errors/decision-lookup.errors';

const LOOKUP_PATH = '/internal/v1/decisions/lookup';

@Injectable()
export class DecisionLookupClient {
  // 의존성 전체를 한 번의 요청으로 조회한다.
  //
  // 응답은 파싱하지 않고 원본 형태로 반환한다. 계약 검증은 Adapter의 책임이다.
  async lookup(request: DecisionLookupRequestDto): Promise<unknown> {
    const url = `${resolveDecisionDbBaseUrl()}${LOOKUP_PATH}`;

    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        // 조회가 멈추면 npm 요청 전체가 매달리므로 상한을 둔다
        signal: AbortSignal.timeout(resolveDecisionDbTimeoutMs()),
      });
    } catch (error) {
      throw new DecisionLookupRequestError(
        'decision lookup request failed',
        null,
        error,
      );
    }

    if (!response.ok) {
      throw new DecisionLookupRequestError(
        `decision lookup request failed with status ${response.status}`,
        response.status,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new DecisionLookupInvalidResponseError(
        'response body is not valid JSON',
        error,
      );
    }
  }
}
