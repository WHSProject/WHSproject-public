// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const { Pool } = vi.hoisted(() => ({ Pool: vi.fn(function Pool(this: object, options: unknown) { Object.assign(this, { options }) }) }))

vi.mock('pg', () => ({ Pool }))

describe('getPool', () => {
  it('creates one pool on first use from the DB_* variables', async () => {
    vi.stubEnv('DB_HOST', 'postgres')
    vi.stubEnv('DB_PORT', '5432')
    vi.stubEnv('DB_NAME', 'user_db')
    const { getPool } = await import('@/lib/db')
    expect(Pool).not.toHaveBeenCalled()

    const first = getPool()
    expect(getPool()).toBe(first)
    expect(Pool).toHaveBeenCalledOnce()
    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ host: 'postgres', port: 5432, database: 'user_db' }))
    vi.unstubAllEnvs()
  })
})

describe('isUniqueViolation', () => {
  it('finds the PostgreSQL unique violation code, also inside wrapped errors', async () => {
    const { isUniqueViolation } = await import('@/lib/db')
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })

    expect(isUniqueViolation(pgError)).toBe(true)
    expect(isUniqueViolation(new Error('wrapped', { cause: pgError }))).toBe(true)
    expect(isUniqueViolation(new Error('twice', { cause: new Error('once', { cause: pgError }) }))).toBe(true)
    expect(isUniqueViolation(Object.assign(new Error('other'), { code: '23503' }))).toBe(false)
    expect(isUniqueViolation(new Error('plain'))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation('23505')).toBe(false)
  })
})
