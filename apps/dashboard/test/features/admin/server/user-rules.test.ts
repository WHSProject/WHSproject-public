// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { type Participant, planBanChange, planRoleChange } from '@/features/admin/server/user-rules'

const RANKS: Record<string, number> = { viewer: 10, editor: 20, admin: 30 }
const rankOf = (role: string) => RANKS[role]

const admin = (id: string, active = true): Participant => ({ id, role: 'admin', active })
const user = (id: string, role: string, active = true): Participant => ({ id, role, active })

describe('planRoleChange', () => {
  const base = { actor: admin('a1'), managerIds: ['a1'], rankOf }

  it('promotes without ending the target sessions', () => {
    expect(planRoleChange({ ...base, target: user('u1', 'viewer'), newRole: 'editor' })).toEqual({
      ok: true,
      changed: true,
      revokeSessions: false,
    })
  })

  it.each([
    ['editor', 'viewer'],
    ['admin', 'editor'],
    ['admin', 'viewer'],
  ])('demoting %s → %s ends the target sessions', (from, to) => {
    const managerIds = from === 'admin' ? ['a1', 'u1'] : ['a1']
    expect(planRoleChange({ ...base, managerIds, target: user('u1', from), newRole: to })).toEqual({
      ok: true,
      changed: true,
      revokeSessions: true,
    })
  })

  it('does nothing when the role is the same', () => {
    expect(planRoleChange({ ...base, target: user('u1', 'editor'), newRole: 'editor' })).toEqual({ ok: true, changed: false })
  })

  it('forbids changing yourself', () => {
    expect(planRoleChange({ ...base, target: admin('a1'), newRole: 'viewer' })).toEqual({
      ok: false,
      code: 'SELF_CHANGE_FORBIDDEN',
    })
  })

  it('rejects an unknown role and a missing user', () => {
    expect(planRoleChange({ ...base, target: user('u1', 'viewer'), newRole: 'owner' })).toEqual({ ok: false, code: 'INVALID_ROLE' })
    expect(planRoleChange({ ...base, target: undefined, newRole: 'editor' })).toEqual({ ok: false, code: 'USER_NOT_FOUND' })
  })

  // 요청 사이에 실행자가 강등·비활성화됐다면 transaction 안에서 다시 읽은 값으로 막습니다.
  it.each([
    ['demoted', user('a1', 'editor')],
    ['deactivated', admin('a1', false)],
    ['deleted', undefined],
  ])('rejects an actor who was %s meanwhile', (_, actor) => {
    expect(planRoleChange({ ...base, actor, target: user('u1', 'viewer'), newRole: 'editor' })).toEqual({
      ok: false,
      code: 'ACTOR_FORBIDDEN',
    })
  })

  it('keeps at least one active admin', () => {
    // 실행자가 관리자 목록에 없는 경우(다른 요청이 먼저 커밋)에도 마지막 활성 Admin은 강등하지 않습니다.
    expect(planRoleChange({ ...base, managerIds: ['u1'], target: admin('u1'), newRole: 'editor' })).toEqual({
      ok: false,
      code: 'LAST_ADMIN',
    })
    expect(planRoleChange({ ...base, managerIds: ['a1', 'u1'], target: admin('u1'), newRole: 'editor' }).ok).toBe(true)
  })

  it('allows demoting a deactivated admin because it does not count as an active admin', () => {
    expect(planRoleChange({ ...base, managerIds: ['a1'], target: admin('u1', false), newRole: 'viewer' }).ok).toBe(true)
  })
})

describe('planBanChange', () => {
  const base = { actor: admin('a1'), managerIds: ['a1'] }

  it('deactivates and ends the target sessions', () => {
    expect(planBanChange({ ...base, target: user('u1', 'viewer'), banned: true })).toEqual({
      ok: true,
      changed: true,
      revokeSessions: true,
    })
  })

  it('reactivates without touching sessions', () => {
    expect(planBanChange({ ...base, target: user('u1', 'viewer', false), banned: false })).toEqual({
      ok: true,
      changed: true,
      revokeSessions: false,
    })
  })

  it('does nothing when the state is already the same', () => {
    expect(planBanChange({ ...base, target: user('u1', 'viewer', false), banned: true })).toEqual({ ok: true, changed: false })
    expect(planBanChange({ ...base, target: user('u1', 'viewer'), banned: false })).toEqual({ ok: true, changed: false })
  })

  it('forbids deactivating yourself and acting after losing admin', () => {
    expect(planBanChange({ ...base, target: admin('a1'), banned: true })).toEqual({ ok: false, code: 'SELF_CHANGE_FORBIDDEN' })
    expect(planBanChange({ ...base, actor: user('a1', 'viewer'), target: user('u1', 'viewer'), banned: true })).toEqual({
      ok: false,
      code: 'ACTOR_FORBIDDEN',
    })
  })

  it('never deactivates the last active admin', () => {
    expect(planBanChange({ ...base, managerIds: ['u1'], target: admin('u1'), banned: true })).toEqual({
      ok: false,
      code: 'LAST_ADMIN',
    })
    expect(planBanChange({ ...base, managerIds: ['a1', 'u1'], target: admin('u1'), banned: true }).ok).toBe(true)
  })
})
