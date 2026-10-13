import { APIError } from 'better-auth/api'

import { accountEmail } from '../common/username'

type UserData = Record<string, unknown>

export const NAME_FOLLOWS_USERNAME = 'NAME_FOLLOWS_USERNAME'

// 화면 이름(displayUsername)은 username과 대소문자만 다를 수 있습니다. 다르면 username을 씁니다.
// username 플러그인이 요청 단계에서 username을 소문자로 바꿔 두므로 여기 오는 username은 소문자입니다.
function displayNameFor(data: UserData): string | undefined {
  if (typeof data.username !== 'string' || data.username === '') return undefined
  const display = data.displayUsername
  return typeof display === 'string' && display.toLowerCase() === data.username.toLowerCase() ? display : data.username
}

function invalidUsername(): APIError {
  return APIError.from('BAD_REQUEST', { code: 'INVALID_USERNAME', message: 'Username is invalid' })
}

// 쓰지 않는 인증 API입니다: 회원가입, 이메일 로그인, 메일 발송·인증, 소셜 로그인·연결·해제.
// Better Auth가 기본으로 여는 경로라 요청 단계(auth.ts hooks.before)에서 없는 경로처럼 404로 거절합니다.
// 새 비밀번호 저장(/reset-password)은 Admin이 발급한 링크가 쓰므로 막지 않습니다.
export const DISABLED_AUTH_PATHS: readonly string[] = [
  '/sign-up/email',
  '/sign-in/email',
  '/send-verification-email',
  '/verify-email',
  '/request-password-reset',
  '/sign-in/social',
  '/link-social',
  '/unlink-account',
]

export function rejectDisabledAuthPath(path: string | undefined): void {
  if (path !== undefined && DISABLED_AUTH_PATHS.includes(path)) {
    throw APIError.from('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' })
  }
}

// username 플러그인은 문자열 username만 검사합니다. 문자열이 아닌 값은 null이면 그대로 저장되고,
// 숫자 등은 플러그인 안에서 500이 나므로 update-user 요청 단계(auth.ts hooks.before)에서 먼저 거절합니다.
export function rejectNonStringUsername(path: string | undefined, body: unknown): void {
  if (path !== '/update-user' || typeof body !== 'object' || body === null || !('username' in body)) return
  if (body.username !== undefined && typeof body.username !== 'string') throw invalidUsername()
}

// 정보 변경: username을 바꿀 때만 화면 이름, name, 자동 이메일을 함께 바꿉니다(이메일이 남으면 옛 username으로 새 계정을 만들 때 겹침).
// Better Auth는 hook 결과를 원래 값에 덮어써 합치므로 값을 빼서는 막을 수 없어, username 없이
// name·화면 이름만 바꾸는 요청은 오류로 거절합니다(name = username 규칙).
// update-user는 보내지 않은 name도 undefined로 넘기므로, 값이 undefined인지로 판단합니다(null·숫자도 거절).
export function syncUserUpdate<T extends UserData>(data: T): T {
  if (data.username !== undefined && (typeof data.username !== 'string' || data.username === '')) throw invalidUsername()
  const display = displayNameFor(data)
  if (display) return { ...data, displayUsername: display, name: display, email: accountEmail(display) }
  if (data.name !== undefined || data.displayUsername !== undefined) {
    throw APIError.from('BAD_REQUEST', {
      code: NAME_FOLLOWS_USERNAME,
      message: 'name은 username과 같게 유지되므로 username을 바꿔야 함께 바뀝니다.',
    })
  }
  return data
}

// 비밀번호 변경에 성공한 요청이면 그 사용자 id를 돌려줍니다. 실패한 요청(APIError)은 undefined입니다.
// 비밀번호를 바꾸면 이 기기를 포함한 모든 기기에서 로그아웃시키는 after hook(auth.ts)이 씁니다.
export function passwordChangedUserId(path: string | undefined, returned: unknown): string | undefined {
  if (path !== '/change-password' || typeof returned !== 'object' || returned === null || !('user' in returned)) return undefined
  const user = returned.user
  return typeof user === 'object' && user !== null && 'id' in user && typeof user.id === 'string' ? user.id : undefined
}

export const USER_CREATION_DISABLED = 'user_creation_disabled'

// user.validateUserInfo: 계정은 Admin API·create-admin 스크립트가 DB에 직접 만들므로 Better Auth를 거친 생성은 모두 거절합니다.
// 회원가입 경로 404에 더한 두 번째 방어입니다.
export async function rejectUserCreation() {
  return { error: USER_CREATION_DISABLED }
}
