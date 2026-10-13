'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { providerLabel, roleLabel } from '@/lib/auth/common/labels'
import type { RoleOption } from '@/lib/auth/common/roles'
import { formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'

import { ADMIN_API, type AdminRequestResult, sendAdminRequest } from '../api/admin'
import { ADMIN_REQUEST_FAILED_MESSAGE } from '../model/errors'
import { USER_STATUS_LABELS, type UserStatus, userStatus } from '../model/labels'
import type { AdminUserRow, PasswordLink } from '../types/users'
import styles from './AdminPage.module.css'
import { PasswordLinkNotice } from './PasswordLinkNotice'

const STATUS_CHIP: Record<UserStatus, string> = {
  active: styles.chipPositive,
  banned: styles.chipNegative,
  pending: styles.chipNeutral,
}

type Notice = { tone: 'success' | 'error'; message: string; link?: PasswordLink }

type RowProps = {
  user: AdminUserRow
  roles: RoleOption[]
  isSelf: boolean
  onResult: (result: AdminRequestResult, successMessage: string) => void
  onLink: (result: AdminRequestResult<PasswordLink>, successMessage: string) => void
}

function UserRow({ user, roles, isSelf, onResult, onLink }: RowProps) {
  const [draftRole, setDraftRole] = useState(user.role)
  const [confirmingBan, setConfirmingBan] = useState(false)
  const [pending, setPending] = useState(false)

  const rankOf = (code: string) => roles.find((role) => role.code === code)?.rank ?? 0
  const roleChanged = draftRole !== user.role
  const demoting = roleChanged && rankOf(draftRole) < rankOf(user.role)
  const status = userStatus(user)

  async function run(request: Promise<AdminRequestResult>, successMessage: string) {
    setPending(true)
    const result = await request
    setPending(false)
    setConfirmingBan(false)
    onResult(result, successMessage)
  }

  const saveRole = () =>
    run(
      sendAdminRequest(ADMIN_API.userRole(user.id), 'PUT', { role: draftRole }),
      `${user.displayName} 권한 변경: ${roleLabel(roles, user.role)} → ${roleLabel(roles, draftRole)}`,
    )
  const ban = () =>
    run(sendAdminRequest(ADMIN_API.userBan(user.id), 'PUT'), `${user.displayName} 비활성화: 로그인이 모두 끊겼습니다.`)
  const unban = () => run(sendAdminRequest(ADMIN_API.userBan(user.id), 'DELETE'), `${user.displayName} 활성화했습니다.`)
  // 설정 전이면 설정 링크, 설정했으면 재설정 링크입니다. 새로 발급하면 이전 링크는 쓸 수 없습니다.
  const linkLabel = status === 'pending' ? '설정 링크 재발급' : '재설정 링크'
  async function issueLink() {
    setPending(true)
    const result = await sendAdminRequest<PasswordLink>(ADMIN_API.userPasswordLink(user.id), 'POST')
    setPending(false)
    onLink(
      result,
      status === 'pending'
        ? `${user.displayName} 비밀번호 설정 링크를 다시 발급했습니다. 이전 링크는 쓸 수 없습니다.`
        : `${user.displayName} 비밀번호 재설정 링크를 발급했습니다. 재설정하면 이 사용자의 로그인이 모두 끊깁니다.`,
    )
  }

  return (
    <tr>
      <td className={styles.nowrap}>
        <span className={styles.name}>{user.displayName}</span>
        {isSelf ? <span className={styles.selfTag}>나</span> : null}
      </td>
      <td>
        {isSelf ? (
          <div className={styles.roleControl}>
            <span>{roleLabel(roles, user.role)}</span>
            <p className={styles.hint}>자기 자신의 권한은 바꿀 수 없습니다.</p>
          </div>
        ) : (
          <div className={styles.roleControl}>
            <select
              className={styles.select}
              aria-label={`${user.displayName} 권한`}
              value={draftRole}
              disabled={pending}
              onChange={(event) => setDraftRole(event.target.value)}
            >
              {roles.map((role) => (
                <option key={role.code} value={role.code}>{role.name}</option>
              ))}
            </select>
            {roleChanged ? (
              <>
                <Button className={styles.smallButton} disabled={pending} onClick={() => void saveRole()}>
                  저장
                </Button>
                <Button variant="ghost" className={styles.smallButton} disabled={pending} onClick={() => setDraftRole(user.role)}>
                  취소
                </Button>
                {demoting ? <p className={styles.warning}>강등하면 이 사용자의 로그인이 모두 끊깁니다.</p> : null}
              </>
            ) : null}
          </div>
        )}
      </td>
      <td>
        <span className={`${styles.chip} ${STATUS_CHIP[status]}`}>{USER_STATUS_LABELS[status]}</span>
      </td>
      <td className={styles.nowrap}>
        {user.providers.length > 0 ? user.providers.map(providerLabel).join(', ') : <span className={styles.muted}>-</span>}
      </td>
      <td className={`${styles.mono} ${styles.nowrap}`}>{formatDateTime(user.lastLoginAt)}</td>
      <td>
        {isSelf ? (
          <span className={styles.muted}>-</span>
        ) : (
          <div className={styles.actions}>
            <Button
              variant="ghost"
              className={`${styles.smallButton} ${styles.resetButton}`}
              aria-label={`${user.displayName} ${linkLabel}`}
              disabled={pending}
              onClick={() => void issueLink()}
            >
              {linkLabel}
            </Button>
            {user.banned ? (
              <Button variant="ghost" className={`${styles.smallButton} ${styles.restoreButton}`} disabled={pending} onClick={() => void unban()}>
                활성화
              </Button>
            ) : confirmingBan ? (
              <div className={styles.confirm}>
                <p className={styles.warning}>로그인이 모두 끊기고 다시 로그인할 수 없습니다.</p>
                <Button
                  variant="ghost"
                  className={`${styles.smallButton} ${styles.dangerButton}`}
                  disabled={pending}
                  onClick={() => void ban()}
                >
                  비활성화 확인
                </Button>
                <Button variant="ghost" className={styles.smallButton} disabled={pending} onClick={() => setConfirmingBan(false)}>
                  돌아가기
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                className={`${styles.smallButton} ${styles.dangerButton}`}
                aria-label={`${user.displayName} 비활성화`}
                onClick={() => setConfirmingBan(true)}
              >
                비활성화
              </Button>
            )}
          </div>
        )}
      </td>
    </tr>
  )
}

export function UsersTable({ users, roles, currentUserId }: { users: AdminUserRow[]; roles: RoleOption[]; currentUserId: string }) {
  const router = useRouter()
  const [notice, setNotice] = useState<Notice | null>(null)

  function handleResult(result: AdminRequestResult, successMessage: string) {
    if (!result.ok) {
      setNotice({ tone: 'error', message: result.message })
      return
    }
    setNotice({ tone: 'success', message: successMessage })
    router.refresh()
  }

  // 링크 발급은 목록이 바뀌지 않으므로 다시 그리지 않습니다.
  function handleLink(result: AdminRequestResult<PasswordLink>, successMessage: string) {
    if (!result.ok || !result.data) {
      setNotice({ tone: 'error', message: result.ok ? ADMIN_REQUEST_FAILED_MESSAGE : result.message })
      return
    }
    setNotice({ tone: 'success', message: successMessage, link: result.data })
  }

  return (
    <div className={styles.stack}>
      {notice?.link ? (
        <PasswordLinkNotice message={notice.message} link={notice.link} />
      ) : notice ? (
        <FormNotice tone={notice.tone}>{notice.message}</FormNotice>
      ) : null}
      <div className={styles.tableScroll} role="region" aria-label="사용자 목록" tabIndex={0}>
        <table className={styles.table} aria-label="사용자 목록">
          <thead>
            <tr>
              <th scope="col">사용자</th>
              <th scope="col">권한</th>
              <th scope="col">상태</th>
              <th scope="col">로그인 수단</th>
              <th scope="col">마지막 로그인</th>
              <th scope="col">관리</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              // 서버 데이터가 바뀌면(권한·상태) 행을 새로 만들어 선택 중이던 값을 초기화합니다.
              <UserRow
                key={`${user.id}:${user.role}:${String(user.banned)}`}
                user={user}
                roles={roles}
                isSelf={user.id === currentUserId}
                onResult={handleResult}
                onLink={handleLink}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
