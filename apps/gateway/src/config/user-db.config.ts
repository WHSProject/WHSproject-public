import type { PoolConfig } from 'pg';

const DEFAULT_USER_DB_PORT = 5432;
const DEFAULT_USER_DB_NAME = 'user_db';

// npm 인증과 다운로드 기록(user_db)의 공용 DB 접속 정보.
// DB_HOST가 없으면 인증은 거부하고 기록만 생략한다. 테스트도 실제 앱을 띄우므로
// localhost를 기본값으로 두면 개발자 로컬 DB에 기록이 쌓일 수 있다.
export function resolveUserDbConfig(): PoolConfig | null {
  const host = process.env.DB_HOST?.trim();

  if (!host) {
    return null;
  }

  const port = Number(process.env.DB_PORT);

  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_USER_DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME?.trim() || DEFAULT_USER_DB_NAME,
  };
}
