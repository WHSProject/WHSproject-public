import { isValidUsername, normalizeUsername, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from './username'

// Better Auth 기본값(emailAndPassword.minPasswordLength·maxPasswordLength)과 같습니다.
export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export const USERNAME_RULE_MESSAGE = `username은 ${USERNAME_MIN_LENGTH}~${USERNAME_MAX_LENGTH}자의 영문, 숫자, _만 사용할 수 있습니다.`
export const PASSWORD_RULE_MESSAGE = `비밀번호는 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자로 입력하세요.`
export const PASSWORD_MISMATCH_MESSAGE = '비밀번호가 일치하지 않습니다.'

export function usernameError(value: string): string | undefined {
  return isValidUsername(normalizeUsername(value)) ? undefined : USERNAME_RULE_MESSAGE
}

export function passwordError(value: string): string | undefined {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH ? undefined : PASSWORD_RULE_MESSAGE
}

// 확인 칸은 브라우저에서만 비교하며 서버로 보내지 않습니다.
export function passwordConfirmError(password: string, confirm: string): string | undefined {
  return password === confirm ? undefined : PASSWORD_MISMATCH_MESSAGE
}
