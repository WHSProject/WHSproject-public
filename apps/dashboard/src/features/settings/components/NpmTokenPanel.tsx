'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'
import { formatDateTime } from '@/lib/format'
import styles from './SettingsPage.module.css'

// 사용자 ~/.npmrc에 registry와 토큰을 저장하는 명령입니다(npm login이 하던 일). 발급 직후에는 토큰이 채워집니다.
function npmLoginCommands(token: string): string {
  return `npm config set registry https://<Gateway주소>/npm/\nnpm config set //<Gateway주소>/npm/:_authToken ${token}`
}

export function NpmTokenPanel({ expiresAt: initialExpiresAt, canInstall }: { expiresAt: string | null; canInstall: boolean }) {
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt)
  const [token, setToken] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function update(method: 'POST' | 'DELETE') {
    setPending(true)
    setError(null)
    setNotice(null)
    setToken(null)
    try {
      const response = await fetch('/api/settings/npm-token', { method })
      if (!response.ok) {
        setError(response.status === 403 ? '현재 계정으로 토큰을 발급할 수 없습니다. 권한과 계정 상태를 확인하세요.'
          : response.status === 401 ? '다시 로그인해 주세요.' : '토큰을 변경하지 못했습니다. 새로고침 후 확인하세요.')
        return
      }
      if (method === 'DELETE') {
        setExpiresAt(null)
        setNotice('npm 토큰을 폐기했습니다.')
      } else {
        const data = await response.json() as { token: string; expiresAt: string }
        setToken(data.token)
        setExpiresAt(data.expiresAt)
        setNotice('새 토큰을 발급했습니다. 아래 값을 지금 복사해 보관하세요.')
      }
    } catch {
      setError('서버 응답을 받지 못했습니다. 변경되었을 수 있으므로 새로고침 후 확인하세요.')
    } finally {
      setPending(false)
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="npm-token-title">
      <h2 id="npm-token-title" className={styles.sectionTitle}>npm 설치 토큰</h2>
      <div className={styles.stack}>
        <p className={styles.notice}>토큰은 90일간 유효하며 계정당 1개입니다. 재발급하면 다른 기기의 이전 토큰도 무효화됩니다.</p>
        <p>{expiresAt ? `토큰 만료 시각: ${formatDateTime(expiresAt)}` : '발급된 npm 토큰이 없습니다.'}</p>
        {!canInstall ? <p>Developer 이상만 발급할 수 있습니다. 기존 토큰은 폐기할 수 있습니다.</p> : null}
        <div className={styles.formActions}>
          <Button type="button" disabled={pending || !canInstall} onClick={() => void update('POST')}>{expiresAt ? 'npm 토큰 재발급' : 'npm 토큰 발급'}</Button>
          <Button type="button" disabled={pending || !expiresAt} onClick={() => void update('DELETE')}>npm 토큰 폐기</Button>
        </div>
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
        {notice ? <FormNotice tone="success">{notice}</FormNotice> : null}
        {token ? <TextField label="발급된 npm 토큰" value={token} readOnly autoComplete="off" hint="원문은 이번에만 표시됩니다. 저장소나 로그에 남기지 마세요." /> : null}
        <p className={styles.hint}>
          기존 npm login 대신 아래 두 명령을 컴퓨터마다 한 번 실행하세요. 이후 npm install에서 자동으로 사용자가 식별됩니다.
          {'<Gateway주소>'}는 운영자가 안내한 주소로 바꿉니다.
        </p>
        <pre className={styles.npmConfig}>{npmLoginCommands(token ?? '<발급된 토큰>')}</pre>
        <p className={styles.hint}>
          CI는 전용 계정의 토큰을 Secret으로 주입하고 .npmrc에 {'//<Gateway주소>/npm/:_authToken=${NPM_TOKEN}'}을 사용합니다. 실제 토큰은 커밋하지 않습니다.
        </p>
      </div>
    </section>
  )
}
