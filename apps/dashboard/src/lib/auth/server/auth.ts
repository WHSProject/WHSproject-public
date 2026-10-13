import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { deleteSessionCookie } from 'better-auth/cookies'
import { admin, username } from 'better-auth/plugins'

import { getPool } from '../../db'
import { ac, DEFAULT_ROLE, roles } from '../common/permissions'
import { isValidUsername, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '../common/username'

import {
  passwordChangedUserId,
  rejectDisabledAuthPath,
  rejectNonStringUsername,
  rejectUserCreation,
  syncUserUpdate,
} from './hooks'

// 서버에서만 import합니다. DB 접속 정보와 BETTER_AUTH_SECRET을 다룹니다.
// BETTER_AUTH_SECRET, BETTER_AUTH_URL은 Better Auth가 환경변수에서 직접 읽습니다.
//
// betterAuth()는 호출 즉시 secret 검사 등 초기화를 시작합니다. next build가 라우트 파일을
// 읽을 때 초기화되지 않도록, 인스턴스는 getAuth()를 처음 호출할 때 한 번만 만듭니다.
//
// 로그인은 username·비밀번호만 씁니다. 계정은 Admin이 만들고, 비밀번호는 Admin이 발급한 링크로 설정합니다.

// Better Auth 기본 컬럼명(camelCase)을 기존 DB 규칙(snake_case)에 맞춥니다.
function snakeCase<const Field extends string>(...fields: Field[]): Record<Field, string> {
  return Object.fromEntries(
    fields.map((field) => [field, field.replace(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`)]),
  ) as Record<Field, string>
}

function createAuth() {
  const pool = getPool()

  return betterAuth({
    database: pool,
    user: {
      modelName: 'users',
      fields: snakeCase('emailVerified', 'createdAt', 'updatedAt'),
      // Better Auth를 거친 사용자 생성은 모두 거절합니다(hooks.ts).
      validateUserInfo: rejectUserCreation,
    },
    session: {
      modelName: 'sessions',
      fields: snakeCase('userId', 'expiresAt', 'ipAddress', 'userAgent', 'createdAt', 'updatedAt'),
    },
    // accounts의 토큰 칸은 Better Auth 기본 스키마라 DB에 남아 있고, 비밀번호 수단(credential)만 씁니다.
    account: {
      modelName: 'accounts',
      fields: snakeCase(
        'userId',
        'accountId',
        'providerId',
        'accessToken',
        'refreshToken',
        'idToken',
        'accessTokenExpiresAt',
        'refreshTokenExpiresAt',
        'createdAt',
        'updatedAt',
      ),
    },
    verification: {
      modelName: 'verifications',
      fields: snakeCase('expiresAt', 'createdAt', 'updatedAt'),
    },
    emailAndPassword: {
      enabled: true,
      // 메일 인증을 쓰지 않습니다.
      requireEmailVerification: false,
      // 링크 토큰은 features/admin/server/accounts.ts가 넣습니다. 재설정하면 다른 기기의 로그인을 모두 끊습니다.
      revokeSessionsOnPasswordReset: true,
    },
    databaseHooks: {
      user: {
        update: {
          before: async (user) => ({ data: syncUserUpdate(user) }),
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // 쓰지 않는 인증 API를 404로 거절합니다(목록은 hooks.ts).
        rejectDisabledAuthPath(ctx.path)
        // username 플러그인이 검사하지 않는 문자열이 아닌 username(null, 숫자 등)을 요청 단계에서 거절합니다.
        rejectNonStringUsername(ctx.path, ctx.body)
      }),
      // 비밀번호를 바꾸면 이 기기를 포함한 모든 기기에서 로그아웃시키고 새 비밀번호로 다시 로그인하게 합니다.
      // 요청 본문(revokeOtherSessions)과 관계없이 서버에서 강제합니다.
      after: createAuthMiddleware(async (ctx) => {
        const userId = passwordChangedUserId(ctx.path, ctx.context.returned)
        if (!userId) return
        await ctx.context.internalAdapter.deleteUserSessions(userId)
        deleteSessionCookie(ctx)
      }),
    },
    advanced: {
      database: {
        // PostgreSQL에서는 id를 DB의 gen_random_uuid() 기본값으로 생성합니다.
        generateId: 'uuid',
        // 초기화 때 DB 스키마를 검사하지 않습니다. 스키마 확인은 CLI(cli.ts)로 합니다.
        validateSchema: false,
      },
    },
    telemetry: { enabled: false },
    plugins: [
      username({
        minUsernameLength: USERNAME_MIN_LENGTH,
        maxUsernameLength: USERNAME_MAX_LENGTH,
        usernameValidator: isValidUsername,
        // 화면 이름도 username과 같은 규칙만 허용합니다(대소문자 차이만 허용은 hooks.ts가 확인).
        displayUsernameValidator: isValidUsername,
        schema: { user: { fields: snakeCase('displayUsername') } },
      }),
      admin({
        ac,
        roles,
        defaultRole: DEFAULT_ROLE,
        schema: {
          user: { fields: snakeCase('banReason', 'banExpires') },
          session: { fields: snakeCase('impersonatedBy') },
        },
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

let instance: Auth | undefined

export function getAuth(): Auth {
  instance ??= createAuth()
  return instance
}
