'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { authClient } from '@/lib/auth/client'
import { formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'

import { revokeSession } from '../api/settings'
import { NO_RESPONSE_MESSAGE, sessionErrorMessage } from '../model/errors'
import { describeDevice, describeIp } from '../model/device'
import type { SessionRow } from '../types/account'
import styles from './SettingsPage.module.css'

type Notice = { tone: 'success' | 'error'; message: string }

// 지금 쓰는 기기는 표시만 하고, 다른 기기는 하나씩 또는 한꺼번에 로그아웃할 수 있습니다.
export function SessionsTable({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const others = sessions.filter((session) => !session.current)

  async function revokeOne(session: SessionRow) {
    setPending(session.id)
    setNotice(null)
    const result = await revokeSession(session.id)
    setPending(null)
    if (!result.ok) {
      setNotice({ tone: 'error', message: result.message })
      return
    }
    setNotice({ tone: 'success', message: `${describeDevice(session.userAgent)} 기기를 로그아웃했습니다.` })
    router.refresh()
  }

  async function revokeOthers() {
    setPending('others')
    setNotice(null)
    try {
      const { error } = await authClient.revokeOtherSessions()
      if (error) {
        setNotice({ tone: 'error', message: sessionErrorMessage(error) })
        return
      }
      setNotice({ tone: 'success', message: '다른 기기를 모두 로그아웃했습니다.' })
      router.refresh()
    } catch {
      // HTTP 오류는 error로 오지만 네트워크 오류는 예외로 옵니다.
      setNotice({ tone: 'error', message: NO_RESPONSE_MESSAGE })
    } finally {
      setPending(null)
    }
  }

  return (
    <div className={styles.stack}>
      <div className={styles.sessionsHead}>
        <p className={styles.muted}>지금 로그인되어 있는 기기 {sessions.length}대</p>
        {others.length > 0 ? (
          <Button variant="ghost" className={styles.smallButton} disabled={pending !== null} onClick={() => void revokeOthers()}>
            다른 기기 모두 로그아웃
          </Button>
        ) : null}
      </div>
      {notice ? <FormNotice tone={notice.tone}>{notice.message}</FormNotice> : null}
      <div className={styles.tableScroll} role="region" aria-label="로그인된 기기 목록" tabIndex={0}>
        <table className={styles.table} aria-label="로그인된 기기">
          <thead>
            <tr>
              <th scope="col">기기</th>
              <th scope="col">IP</th>
              <th scope="col">로그인 시각</th>
              <th scope="col">만료 예정</th>
              <th scope="col">관리</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {describeDevice(session.userAgent)}
                  {session.current ? <span className={styles.chip}>현재 기기</span> : null}
                </td>
                <td className={styles.mono}>{describeIp(session.ipAddress)}</td>
                <td className={styles.mono}>{formatDateTime(session.createdAt)}</td>
                <td className={styles.mono}>{formatDateTime(session.expiresAt)}</td>
                <td>
                  {session.current ? (
                    <span className={styles.muted}>-</span>
                  ) : (
                    <Button
                      variant="ghost"
                      className={styles.smallButton}
                      aria-label={`${describeDevice(session.userAgent)} 로그아웃`}
                      disabled={pending !== null}
                      onClick={() => void revokeOne(session)}
                    >
                      로그아웃
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
