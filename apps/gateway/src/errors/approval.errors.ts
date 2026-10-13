import type { Decision } from '../types/decision.types';

// Verdaccio 승인 목록 등록 실패 (네트워크 오류, 비정상 HTTP 응답, Timeout)
//
// 등록에 실패하면 Verdaccio 승인 목록에 Package가 없으므로, 중계해도 403이
// 된다. 그보다 Gateway가 먼저 차단하는 편이 원인이 명확하다.
export class ApprovalRegistrationError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null = null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ApprovalRegistrationError';
  }
}

// Decision이 ACCEPT가 아니어서 요청을 차단함
//
// 공통 Error Contract에서 403으로 매핑된다.
// download_events 기록을 위해 요청 Package 자신의 판정 메타도 보존한다.
export class PackageNotAllowedError extends Error {
  constructor(
    public readonly reasons: string[],
    public readonly decision: Decision | null = null,
    public readonly decisionId: string | null = null,
    public readonly isRoot = false,
  ) {
    super('package is not allowed');
    this.name = 'PackageNotAllowedError';
  }
}
