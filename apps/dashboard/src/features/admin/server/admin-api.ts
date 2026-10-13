import { apiError } from '@/lib/auth/server/request'

import type { AdminActionError } from './user-rules'

// Admin API 규칙 오류를 HTTP 응답으로 바꿉니다. 공용 도구(Origin 확인 등)는 lib/auth/server/request.ts에 있습니다.
const ACTION_STATUS: Record<AdminActionError, number> = {
  ACTOR_FORBIDDEN: 403,
  SELF_CHANGE_FORBIDDEN: 403,
  USER_NOT_FOUND: 404,
  INVALID_ROLE: 400,
  LAST_ADMIN: 409,
  USERNAME_TAKEN: 409,
}

export function adminActionError(code: AdminActionError): Response {
  return apiError(code, ACTION_STATUS[code])
}
