// 인증 관련 화면 경로입니다. 로그인 후 돌아갈 주소 검사(safeCallbackURL)에서도 씁니다.
export const AUTH_ROUTES = {
  login: '/login',
  resetPassword: '/reset-password',
} as const

const AUTH_PATHS: readonly string[] = Object.values(AUTH_ROUTES)

// 로그인 화면 주소입니다. 돌아갈 화면이 기본(/)이 아니면 callbackURL로 붙여 로그인 뒤 그 화면으로 갑니다.
export function loginURL(callbackURL = '/'): string {
  return callbackURL === '/' ? AUTH_ROUTES.login : `${AUTH_ROUTES.login}?callbackURL=${encodeURIComponent(callbackURL)}`
}

// 로그인 화면 위에 보여 줄 안내(?notice=)입니다. 목록에 없는 값은 무시합니다.
export const LOGIN_NOTICES = {
  'password-changed': '비밀번호를 변경했습니다. 모든 기기에서 로그아웃되었으니 새 비밀번호로 다시 로그인하세요.',
} as const

export type LoginNotice = keyof typeof LOGIN_NOTICES

export function loginNotice(value: unknown): LoginNotice | undefined {
  return typeof value === 'string' && Object.hasOwn(LOGIN_NOTICES, value) ? (value as LoginNotice) : undefined
}

// 탭·줄바꿈 같은 제어 문자는 브라우저가 지워 버려 '/\t/example.com'이 '//example.com'이 될 수 있습니다.
function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}

// 로그인 뒤 돌아갈 주소는 이 사이트 안의 화면 경로만 허용합니다.
// 외부 사이트(//example.com), 제어 문자, API, 인증 화면(로그인 무한 반복)은 기본 화면으로 바꿉니다.
export function safeCallbackURL(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback
  if (value.startsWith('//') || value.startsWith('/\\') || hasControlCharacter(value)) return fallback

  const path = value.split(/[?#]/u, 1)[0]
  if (path.startsWith('/api/') || AUTH_PATHS.includes(path)) return fallback
  return value
}
