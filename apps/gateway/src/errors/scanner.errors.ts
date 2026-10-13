// Scanner 분석 요청 실패 (네트워크 오류, 비정상 HTTP 응답, Timeout)
//
// 성공 판단은 HTTP 상태로만 한다. 어떤 Package가 실제로 분석되었는지는
// 이후 Decision 재조회로 확인하므로, 응답 본문 관련 오류 타입을 두지 않는다.
export class ScannerRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number | null = null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ScannerRequestError';
  }
}
