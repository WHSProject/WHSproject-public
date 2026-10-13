// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, getSession, applyRules } = vi.hoisted(() => ({ authorize: vi.fn(), getSession: vi.fn(), applyRules: vi.fn() }))

vi.mock('@/lib/auth/server/session', () => ({ authorize, getSession }))
vi.mock('@/features/rules/server/rules', () => ({ applyRules }))

import { POST } from '@/app/api/policies/[key]/versions/route'
import { PolicyDbError } from '@/lib/policy/server/policy-db'

import { reviewRule, rule } from '../../../../../lib/policy/fixtures'

const ORIGIN = 'http://localhost:5173'
const post = (body: unknown, origin = ORIGIN) =>
  POST(new Request(`${ORIGIN}/api/policies/qa-npm-policy/versions`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ key: 'qa-npm-policy' }),
  })

beforeEach(() => {
  authorize.mockReset().mockResolvedValue({ session: { user: { username: 'kim_editor', name: 'Kim' } } })
  applyRules.mockReset()
})

describe('POST /api/policies/[key]/versions', () => {
  it('applies the rules as the signed-in user and returns the new version', async () => {
    applyRules.mockResolvedValue({ ok: true, version: '0.1.3' })

    const response = await post({ baseVersion: '0.1.2', rules: [rule(), reviewRule] })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ version: '0.1.3' })
    expect(authorize).toHaveBeenCalledWith('policy:publish')
    expect(applyRules).toHaveBeenCalledWith({ policyKey: 'qa-npm-policy', baseVersion: '0.1.2', rules: [rule(), reviewRule], username: 'kim_editor' })
  })

  it('rejects other origins and users without policy:publish before reading the body', async () => {
    expect((await post({}, 'http://evil.test')).status).toBe(403)
    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await post({ baseVersion: '0.1.2', rules: [] })).status).toBe(403)
    expect(applyRules).not.toHaveBeenCalled()
  })

  it.each([
    {},
    { baseVersion: '0.1.2' },
    { baseVersion: 'latest', rules: [] },
    { baseVersion: '0.1.2', rules: [{ ...rule(), priority: '90' }] },
  ])('returns 400 for a malformed body %#', async (body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'INVALID_RULES' })
    expect(applyRules).not.toHaveBeenCalled()
  })

  it('returns the validation issues and Policy errors', async () => {
    const issues = [{ ruleCode: 'RULE-REJECT-EXFIL', message: '우선순위는 1~100 사이의 정수여야 합니다.' }]
    applyRules.mockResolvedValueOnce({ ok: false, issues })
    let response = await post({ baseVersion: '0.1.2', rules: [rule({ priority: 400 })] })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'INVALID_RULES', issues })

    applyRules.mockRejectedValueOnce(new PolicyDbError('POLICY_CHANGED', 409))
    response = await post({ baseVersion: '0.1.2', rules: [rule()] })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'POLICY_CHANGED' })
  })
})
