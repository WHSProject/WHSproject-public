import { Pool } from 'pg'

// 사용자 DB(user_db) 연결입니다. 서버에서만 import합니다.
// Better Auth와 Admin 기능이 같은 연결을 씁니다. next build 때 연결하지 않도록 처음 호출할 때 한 번만 만듭니다.
let pool: Pool | undefined

export function getPool(): Pool {
  pool ??= new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  })
  return pool
}

// 조회만 하는 함수는 Pool 대신 이 타입을 받습니다. 테스트는 query만 흉내 내면 됩니다.
export type Queryable = Pick<Pool, 'query'>

// PostgreSQL 유일 제약 위반(23505)인지 확인합니다. Better Auth처럼 오류를 감싸는 경우를 위해 cause도 따라가 봅니다.
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}
