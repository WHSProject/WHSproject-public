// 설치 직후 첫 Admin 계정을 만들고 비밀번호 설정 링크를 출력합니다. 실행 방법은 README "처음 로그인하기".
// 비밀번호를 설정한 Admin이 있으면 거절하고, 설정 전 Admin을 다시 지정하면 링크만 새로 발급합니다(만료 대비).
// 운영 이미지에서 src(TS)를 실행할 수 없어 따로 둔 스크립트입니다.
// src/features/admin/server/accounts.ts와 같은 형식(username·email·링크 토큰)으로 넣으므로 바꾸면 함께 바꿉니다.
import { randomBytes } from 'node:crypto'

import pg from 'pg'

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,30}$/u
const LINK_TTL_MS = 60 * 60 * 1000

function exit(message) {
  console.error(message)
  process.exit(1)
}

const display = (process.argv[2] ?? '').trim()
if (!USERNAME_PATTERN.test(display)) exit('사용법: create-admin <username>   (username: 영문·숫자·_ 3~30자)')
const username = display.toLowerCase()

const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})
const client = await pool.connect()

try {
  await client.query('BEGIN')

  const ready = await client.query(
    `SELECT 1 FROM users u
      WHERE u.role = 'admin' AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.provider_id = 'credential')
      LIMIT 1`,
  )
  if (ready.rowCount > 0) throw new Error('비밀번호를 설정한 Admin이 이미 있습니다. 계정은 Admin 화면(/admin/users)에서 만드세요.')

  // 동시에 재발급해도 링크가 1개만 남도록 행을 잠급니다(accounts.ts issuePasswordLink와 같은 이유).
  const existing = await client.query('SELECT id, role FROM users WHERE username = $1 FOR UPDATE', [username])
  let userId = existing.rows[0]?.id
  if (userId && existing.rows[0].role !== 'admin') throw new Error(`이미 있는 username입니다: ${username}`)
  if (!userId) {
    const inserted = await client.query(
      `INSERT INTO users (name, email, email_verified, username, display_username, role, banned)
       VALUES ($1, $2, false, $3, $1, 'admin', false) RETURNING id`,
      [display, `${username}@argus.local`, username],
    )
    userId = inserted.rows[0].id
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + LINK_TTL_MS)
  await client.query(`DELETE FROM verifications WHERE identifier LIKE 'reset-password:%' AND value = $1`, [userId])
  await client.query('INSERT INTO verifications (identifier, value, expires_at) VALUES ($1, $2, $3)', [
    `reset-password:${token}`,
    userId,
    expiresAt,
  ])
  await client.query('COMMIT')

  const origin = new URL(process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').origin
  console.log(`${existing.rowCount > 0 ? '설정 링크를 다시 발급했습니다' : 'Admin 계정을 만들었습니다'}: ${username}`)
  console.log(`아래 링크에서 비밀번호를 설정하세요(1시간 동안 한 번만 사용, 만료 ${expiresAt.toISOString()}):`)
  console.log(`${origin}/reset-password?token=${token}`)
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  process.exitCode = 1
  console.error(error instanceof Error ? error.message : error)
} finally {
  client.release()
  await pool.end()
}
