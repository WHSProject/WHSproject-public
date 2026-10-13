// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authorize, getSession, activateVersion } = vi.hoisted(() => ({ authorize: vi.fn(), getSession: vi.fn(), activateVersion: vi.fn() }))

vi.mock('@/lib/auth/server/session', () => ({ authorize, getSession }))
vi.mock('@/features/versions/server/versions', () => ({ activateVersion }))

import { POST } from '@/app/api/policies/[key]/versions/[version]/publish/route'
import { PolicyDbError } from '@/lib/policy/server/policy-db'

const ORIGIN = 'http://localhost:5173'
const post = (version: string, body: unknown, origin = ORIGIN) =>
  POST(
    new Request(`${ORIGIN}/api/policies/qa-npm-policy/versions/${version}/publish`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ key: 'qa-npm-policy', version }) },
  )

beforeEach(() => {
  authorize.mockReset().mockResolvedValue({ session: { user: { username: 'kim_editor', name: 'Kim' } } })
  activateVersion.mockReset()
})

describe('POST /api/policies/[key]/versions/[version]/publish', () => {
  it('activates the version as the signed-in user', async () => {
    activateVersion.mockResolvedValue(undefined)

    const response = await post('0.1.2', { baseVersion: '0.1.3' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ version: '0.1.2' })
    expect(authorize).toHaveBeenCalledWith('policy:publish')
    expect(activateVersion).toHaveBeenCalledWith({ policyKey: 'qa-npm-policy', version: '0.1.2', baseVersion: '0.1.3', username: 'kim_editor' })
  })

  it('rejects other origins and users without policy:publish', async () => {
    expect((await post('0.1.2', { baseVersion: '0.1.3' }, 'http://evil.test')).status).toBe(403)
    authorize.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await post('0.1.2', { baseVersion: '0.1.3' })).status).toBe(403)
    expect(activateVersion).not.toHaveBeenCalled()
  })

  it.each([
    ['0.1.2', {}],
    ['0.1.2', { baseVersion: 'latest' }],
    ['latest', { baseVersion: '0.1.3' }],
  ])('returns 400 for version %s with body %j', async (version, body) => {
    const response = await post(version, body)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'INVALID_VERSION' })
    expect(activateVersion).not.toHaveBeenCalled()
  })

  it('passes refusals through with their code', async () => {
    activateVersion.mockRejectedValueOnce(new PolicyDbError('POLICY_VERSION_NOT_APPLICABLE', 422))
    const response = await post('0.0.9', { baseVersion: '0.1.3' })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ error: 'POLICY_VERSION_NOT_APPLICABLE' })
  })
})
