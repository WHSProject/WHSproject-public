import type { AdminUserRow } from '../types/users'

export type UserStatus = 'active' | 'banned' | 'pending'

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  active: '활성',
  banned: '비활성',
  pending: '설정 대기',
}

// 비활성화가 우선이고, 비밀번호를 아직 설정하지 않은 계정은 로그인할 수 없어 "설정 대기"입니다.
export function userStatus(user: Pick<AdminUserRow, 'banned' | 'providers'>): UserStatus {
  if (user.banned) return 'banned'
  return user.providers.includes('credential') ? 'active' : 'pending'
}
