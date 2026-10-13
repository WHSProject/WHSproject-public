import { PASSWORD_RULE_MESSAGE, USERNAME_RULE_MESSAGE } from '@/lib/auth/common/validation'

// Better Auth·개인 설정 API 오류를 화면 문구로 바꿉니다.
export type SettingsErrorLike = { status?: number; code?: string } | null | undefined

export const SETTINGS_REQUEST_FAILED_MESSAGE = '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.'
// 네트워크 오류로 응답을 받지 못한 경우입니다. 서버에서는 처리됐을 수 있어 성공·실패를 단정하지 않습니다.
export const NO_RESPONSE_MESSAGE = '서버 응답을 받지 못했습니다. 화면을 새로고침해 결과를 확인한 뒤 다시 시도하세요.'
const RATE_LIMITED_MESSAGE = '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'
const SIGNED_OUT_MESSAGE = '로그인이 만료되었습니다. 다시 로그인하세요.'

function common(error: SettingsErrorLike): string | undefined {
  if (error?.status === 429) return RATE_LIMITED_MESSAGE
  if (error?.status === 401 || error?.code === 'unauthorized') return SIGNED_OUT_MESSAGE
  return undefined
}

export function usernameErrorMessage(error: SettingsErrorLike): string {
  switch (error?.code) {
    case 'USERNAME_IS_ALREADY_TAKEN':
      return '이미 사용 중인 username입니다. 다른 username을 입력하세요.'
    case 'INVALID_USERNAME':
    case 'USERNAME_TOO_SHORT':
    case 'USERNAME_TOO_LONG':
    case 'INVALID_DISPLAY_USERNAME':
    case 'NAME_FOLLOWS_USERNAME':
      return USERNAME_RULE_MESSAGE
    default:
      return common(error) ?? SETTINGS_REQUEST_FAILED_MESSAGE
  }
}

export function passwordChangeErrorMessage(error: SettingsErrorLike): string {
  switch (error?.code) {
    case 'INVALID_PASSWORD':
      return '현재 비밀번호가 올바르지 않습니다.'
    case 'PASSWORD_TOO_SHORT':
    case 'PASSWORD_TOO_LONG':
      return PASSWORD_RULE_MESSAGE
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
      return '비밀번호로 로그인하는 계정이 아닙니다.'
    default:
      return common(error) ?? SETTINGS_REQUEST_FAILED_MESSAGE
  }
}

export function sessionErrorMessage(error: SettingsErrorLike): string {
  switch (error?.code) {
    case 'SESSION_NOT_FOUND':
      return '이미 로그아웃된 기기입니다. 화면을 새로고침하세요.'
    case 'CURRENT_SESSION':
      return '지금 쓰는 기기는 오른쪽 위의 로그아웃 버튼을 사용하세요.'
    case 'INVALID_ORIGIN':
      return '허용되지 않은 요청입니다. 화면을 새로고침한 뒤 다시 시도하세요.'
    default:
      return common(error) ?? SETTINGS_REQUEST_FAILED_MESSAGE
  }
}
