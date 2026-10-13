// Decision DB 조회 요청 실패 (네트워크 오류, 비정상 HTTP 응답, Timeout)
export class DecisionLookupRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null = null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'DecisionLookupRequestError';
  }
}

// 조회 응답이 합의된 계약을 따르지 않음
//
// Client의 잘못이 아니라 내부 Service 간 계약 위반이므로, 공통 Error Contract
// 에서 Internal Error로 처리되어 상세 내용이 외부에 노출되지 않는다.
export class DecisionLookupInvalidResponseError extends Error {
  constructor(public readonly reason: string, cause?: unknown) {
    super(`invalid decision lookup response: ${reason}`, { cause });
    this.name = 'DecisionLookupInvalidResponseError';
  }
}
