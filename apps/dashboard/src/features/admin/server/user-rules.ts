import { hasPermission } from '@/lib/auth/common/permissions'

// Admin 관리 화면의 권한 변경·비활성화 규칙입니다. DB 잠금·반영은 users.ts가 하고, 판단은 여기서 합니다.

// active: 비활성화(ban)되지 않은 사용자. 기간이 지난 비활성화도 활성으로 봅니다.
export type Participant = { id: string; role: string; active: boolean }

export type AdminActionError =
  | 'ACTOR_FORBIDDEN'
  | 'USER_NOT_FOUND'
  | 'SELF_CHANGE_FORBIDDEN'
  | 'INVALID_ROLE'
  | 'LAST_ADMIN'
  | 'USERNAME_TAKEN'

export type AdminActionPlan =
  | { ok: true; changed: false }
  | { ok: true; changed: true; revokeSessions: boolean }
  | { ok: false; code: AdminActionError }

export type PlanInput = {
  actor: Participant | undefined
  target: Participant | undefined
  // 잠금을 건 뒤 다시 읽은, 사용자를 관리할 수 있는 활성 사용자의 id
  managerIds: readonly string[]
}

export const canManageUsers = (role: string) => hasPermission(role, 'user:manage')

const fail = (code: AdminActionError): AdminActionPlan => ({ ok: false, code })

// 요청을 보낸 뒤 실행자가 강등·비활성화됐을 수 있으므로 DB에서 다시 읽은 값으로 확인합니다.
export function checkActor(actor: Participant | undefined): AdminActionError | undefined {
  return actor?.active && canManageUsers(actor.role) ? undefined : 'ACTOR_FORBIDDEN'
}

// 대상이 있어야 하고 자기 자신은 안 됩니다. 비밀번호 설정·재설정 링크 발급(accounts.ts)도 이 규칙을 씁니다.
// 자기 비밀번호는 개인 설정에서 바꿉니다.
export function checkParticipants({ actor, target }: Pick<PlanInput, 'actor' | 'target'>): AdminActionError | undefined {
  const actorError = checkActor(actor)
  if (actorError) return actorError
  if (!target) return 'USER_NOT_FOUND'
  if (target.id === actor?.id) return 'SELF_CHANGE_FORBIDDEN'
  return undefined
}

// 대상이 관리 권한을 잃으면 관리할 수 있는 활성 사용자가 남는지 봅니다.
function leavesNoManager({ target, managerIds }: PlanInput): boolean {
  if (!target?.active || !canManageUsers(target.role)) return false
  return managerIds.every((id) => id === target.id)
}

// 권한 변경: 강등(rank가 낮아짐)이면 대상의 로그인을 모두 끊습니다.
export function planRoleChange(input: PlanInput & { newRole: string; rankOf: (role: string) => number | undefined }): AdminActionPlan {
  const invalid = checkParticipants(input)
  if (invalid) return fail(invalid)

  const target = input.target as Participant
  const newRank = input.rankOf(input.newRole)
  if (newRank === undefined) return fail('INVALID_ROLE')
  if (target.role === input.newRole) return { ok: true, changed: false }
  if (!canManageUsers(input.newRole) && leavesNoManager(input)) return fail('LAST_ADMIN')

  const previousRank = input.rankOf(target.role)
  return { ok: true, changed: true, revokeSessions: previousRank === undefined || newRank < previousRank }
}

// 비활성화·활성화: 비활성화하면 대상의 로그인을 모두 끊습니다.
export function planBanChange(input: PlanInput & { banned: boolean }): AdminActionPlan {
  const invalid = checkParticipants(input)
  if (invalid) return fail(invalid)

  const target = input.target as Participant
  if (input.banned === !target.active) return { ok: true, changed: false }
  if (input.banned && leavesNoManager(input)) return fail('LAST_ADMIN')
  return { ok: true, changed: true, revokeSessions: input.banned }
}
