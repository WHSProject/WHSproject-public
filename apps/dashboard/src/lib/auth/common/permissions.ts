import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements } from 'better-auth/plugins/admin/access'

// 역할별 권한은 DB가 아니라 이 파일에서 정의합니다. 역할 값은 user_db.roles.code와 같아야 합니다.
export const statement = {
  dashboard: ['read'],
  decision: ['read'],
  policy: ['read', 'draft', 'publish'],
  llm_judgment: ['read'],
  predicate: ['manage'],
  audit: ['read'],
  // Gateway를 거친 npm 패키지 설치입니다. Gateway 인증 연동 때 검사합니다.
  package: ['install'],
  // read·manage는 Dashboard 화면용, 나머지는 admin 플러그인 API가 검사하는 권한입니다.
  user: ['read', 'manage', ...defaultStatements.user],
  session: [...defaultStatements.session],
} as const

export const ac = createAccessControl(statement)

const readOnly = {
  dashboard: ['read'],
  decision: ['read'],
  policy: ['read'],
} as const

export const viewer = ac.newRole(readOnly)

export const developer = ac.newRole({
  ...readOnly,
  package: ['install'],
})

export const editor = ac.newRole({
  ...readOnly,
  policy: ['read', 'draft', 'publish'],
  llm_judgment: ['read'],
  package: ['install'],
})

// admin 플러그인 API(/api/auth/admin/*) 권한은 하나도 부여하지 않습니다.
// 사용자 관리는 Admin API(/api/admin/*)로만 하며, 그쪽에서 자기 변경 금지·마지막 Admin 보호·
// 변경한 사람 기록을 적용합니다. 비활성화 사용자의 로그인 차단은 권한과 무관하게 플러그인이 합니다.
export const admin = ac.newRole({
  ...readOnly,
  policy: ['read', 'draft', 'publish'],
  llm_judgment: ['read'],
  predicate: ['manage'],
  audit: ['read'],
  package: ['install'],
  user: ['read', 'manage'],
})

export const roles = { viewer, developer, editor, admin }

export type RoleCode = keyof typeof roles

export const DEFAULT_ROLE: RoleCode = 'viewer'

type Statement = typeof statement

// 'resource:action' 형태의 권한 이름입니다. 예: 'policy:draft'
export type Permission = {
  [Resource in keyof Statement]: `${Resource}:${Statement[Resource][number]}`
}[keyof Statement]

// 역할이 권한을 가졌는지 확인합니다. 모르는 역할이나 역할이 없으면 거부합니다.
export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (!role || !Object.hasOwn(roles, role)) return false

  const separator = permission.indexOf(':')
  const resource = permission.slice(0, separator)
  const action = permission.slice(separator + 1)
  return roles[role as RoleCode].authorize({ [resource]: [action] }).success
}
