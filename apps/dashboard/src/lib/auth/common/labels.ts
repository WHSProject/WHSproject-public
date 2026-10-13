import type { RoleOption } from './roles'

// 로그인 수단(accounts.provider_id)과 역할 이름의 화면 표시입니다. Admin·개인 설정 화면이 함께 씁니다.
const PROVIDER_LABELS: Record<string, string> = {
  credential: '비밀번호',
}

export function providerLabel(providerId: string): string {
  return PROVIDER_LABELS[providerId] ?? providerId
}

// 역할 이름은 DB roles.name을 씁니다. 목록에 없는 코드는 그대로 보여 줍니다.
export function roleLabel(roles: readonly RoleOption[], code: string): string {
  return roles.find((role) => role.code === code)?.name ?? code
}
