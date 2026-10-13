import { PASSWORD_RULE_MESSAGE } from '@/lib/auth/common/validation'

// Better Auth 응답 오류를 화면 문구로 바꿉니다.
// 로그인 실패는 계정이 있는지 드러나지 않도록 하나의 문구로 묶습니다.
export type AuthErrorLike = { status?: number; code?: string } | null | undefined

export const RATE_LIMITED_MESSAGE = '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'
const REQUEST_FAILED_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'

export function loginErrorMessage(error: AuthErrorLike): string {
  if (error?.status === 429) return RATE_LIMITED_MESSAGE
  if (error?.code === 'BANNED_USER') return '사용이 중지된 계정입니다. 관리자에게 문의하세요.'
  return 'username이나 비밀번호가 올바르지 않습니다.'
}

export function resetPasswordErrorMessage(error: AuthErrorLike): string {
  if (error?.status === 429) return RATE_LIMITED_MESSAGE
  if (error?.code === 'INVALID_TOKEN') return '링크가 만료되었거나 이미 사용되었습니다. Admin에게 새 링크를 요청하세요.'
  if (error?.code === 'PASSWORD_TOO_SHORT' || error?.code === 'PASSWORD_TOO_LONG') return PASSWORD_RULE_MESSAGE
  return REQUEST_FAILED_MESSAGE
}
