// Rules·Versions API 응답의 오류 코드({ error: 코드 })와 화면 첫 데이터 오류를 화면 문구로 바꿉니다.
export const POLICY_REQUEST_FAILED_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'

const MESSAGES: Record<string, string> = {
  unauthorized: '로그인이 만료되었습니다. 다시 로그인하세요.',
  forbidden: '이 작업을 할 권한이 없습니다.',
  INVALID_ORIGIN: '허용되지 않은 요청입니다. 화면을 새로고침한 뒤 다시 시도하세요.',
  INVALID_RULES: 'Rule 입력값을 확인하세요.',
  POLICY_CHANGED: '다른 사용자가 먼저 적용 버전을 바꿨습니다. 화면을 새로고침한 뒤 다시 시도하세요.',
  POLICY_VERSION_ALREADY_EXISTS: '다른 사용자가 먼저 새 버전을 적용했습니다. 화면을 새로고침한 뒤 다시 편집하세요.',
  POLICY_NOT_FOUND: '적용 중인 npm 정책이 없습니다. Policy DB에 초기 정책을 먼저 등록해야 합니다.',
  POLICY_UNAVAILABLE: 'Policy 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',
  POLICY_INVALID_RESPONSE: 'Policy 서비스 응답 형식이 예상과 다릅니다. Policy 담당자에게 알려 주세요.',
  POLICY_UNSUPPORTED_RULE: '이 화면에서 편집할 수 없는 조건 형식(모든 조건과 하나 이상을 함께 쓰는 등)의 Rule이 있습니다. Policy 담당자에게 알려 주세요.',
  POLICY_REJECTED: 'Policy 서비스가 요청을 거절했습니다.',
  UNKNOWN_POLICY_PREDICATE: 'Policy에 등록되지 않은 조건이 있어 적용할 수 없습니다.',
  INVALID_VERSION: '버전 형식이 올바르지 않습니다.',
  POLICY_VERSION_NOT_FOUND: '정책 버전을 찾을 수 없습니다. 화면을 새로고침하세요.',
  POLICY_VERSION_ALREADY_ACTIVE: '이미 적용 중인 버전입니다.',
  POLICY_VERSION_NOT_APPLICABLE: '이 버전은 적용할 수 없습니다(이전 Policy 내부 버전이거나 초안).',
}

export function policyErrorMessage(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : POLICY_REQUEST_FAILED_MESSAGE
}

// 화면 첫 데이터를 읽지 못했을 때의 안내입니다. 모르는 코드는 코드를 함께 보여 줍니다.
export function unavailableMessage(code: string): string {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : `Policy 정책을 불러오지 못했습니다(${code}).`
}
