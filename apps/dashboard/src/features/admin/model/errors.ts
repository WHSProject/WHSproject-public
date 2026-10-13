import { USERNAME_RULE_MESSAGE } from '@/lib/auth/common/validation'

// Admin API 응답의 오류 코드({ error: 코드 })를 화면 문구로 바꿉니다.
export const ADMIN_REQUEST_FAILED_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'

const MESSAGES: Record<string, string> = {
  unauthorized: '로그인이 만료되었습니다. 다시 로그인하세요.',
  forbidden: '이 작업을 할 권한이 없습니다.',
  INVALID_ORIGIN: '허용되지 않은 요청입니다. 화면을 새로고침한 뒤 다시 시도하세요.',
  INVALID_USERNAME: USERNAME_RULE_MESSAGE,
  USERNAME_TAKEN: '이미 있는 username입니다.',
  USER_NOT_FOUND: '사용자를 찾을 수 없습니다. 화면을 새로고침하세요.',
  INVALID_ROLE: '알 수 없는 권한입니다.',
  SELF_CHANGE_FORBIDDEN: '자기 자신의 권한과 상태는 바꿀 수 없습니다.',
  LAST_ADMIN: '마지막 Admin은 강등하거나 비활성화할 수 없습니다.',
  ACTOR_FORBIDDEN: '내 권한이 바뀌어 이 작업을 할 수 없습니다. 화면을 새로고침하세요.',
}

export function adminErrorMessage(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : ADMIN_REQUEST_FAILED_MESSAGE
}
