// 입력은 대소문자를 모두 받고, username 플러그인이 소문자로 저장합니다. 입력한 원래 표기는 display_username에 남습니다.
// better-auth 1.7.5·1.7.6의 username 로그인은 정규화 전 값을 검사하므로 대문자를 여기서 허용해야 로그인이 됩니다.
// 영문·숫자·_만 허용합니다. 저장 값(소문자)은 npm 계정 이름 규칙(소문자, URL에 그대로 쓰는 문자)에도 맞습니다.
export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 30

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/u

export function isValidUsername(username: string): boolean {
  return (
    username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username)
  )
}

// 입력한 username을 보내기 전에 앞뒤 공백을 지웁니다.
export function normalizeUsername(value: string): string {
  return value.trim()
}

// Better Auth 필수 칸인 email의 자동값입니다. 로그인·화면에 쓰지 않습니다. scripts/create-admin.js도 같은 형식을 씁니다.
export function accountEmail(username: string): string {
  return `${username.toLowerCase()}@argus.local`
}
