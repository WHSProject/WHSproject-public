import { Injectable } from '@nestjs/common';

import {
  resolveVerdaccioBaseUrl,
  resolveVerdaccioTimeoutMs,
  resolveApprovalServiceToken,
} from '../config/verdaccio.config';
import type { ApprovalRequestDto } from '../dto/approval-request.dto';
import { ApprovalRegistrationError } from '../errors/approval.errors';

// Verdaccio Approval Plugin이 제공하는 승인 목록 등록 경로.
// config.yaml 의 middlewares.whs-approval.endpoint 와 일치해야 한다.
const APPROVAL_PATH = '/-/whs/approvals';

// 등록 완료를 뜻하는 응답 상태.
const REGISTERED_STATUS = 200;

@Injectable()
export class ApprovalClient {
  // ACCEPT된 Package 목록을 Verdaccio 승인 목록에 등록한다.
  // Verdaccio는 목록에 없는 Package를 403으로 차단하므로 등록이 끝나야 중계가 통과한다.
  async register(request: ApprovalRequestDto): Promise<void> {
    const url = `${resolveVerdaccioBaseUrl()}${APPROVAL_PATH}`;
    const token = resolveApprovalServiceToken();

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-request-id': request.requestId,
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(resolveVerdaccioTimeoutMs()),
      });
    } catch (error) {
      throw new ApprovalRegistrationError(
        'approval registration failed',
        null,
        error,
      );
    }

    // 본문을 쓰지 않으므로 연결 재사용을 위해 정리한다.
    // 끊긴 연결에서는 cancel이 reject하며(실측), 처리하지 않으면 unhandled rejection으로 프로세스가 종료된다.
    response.body?.cancel().catch(() => undefined);

    if (response.status !== REGISTERED_STATUS) {
      throw new ApprovalRegistrationError(
        `approval registration failed with status ${response.status}`,
        response.status,
      );
    }
  }
}
