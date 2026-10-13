'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'

import { authClient } from '@/lib/auth/client'
import { normalizeUsername } from '@/lib/auth/common/username'
import { USERNAME_RULE_MESSAGE, usernameError } from '@/lib/auth/common/validation'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'

import { NO_RESPONSE_MESSAGE, usernameErrorMessage } from '../model/errors'
import styles from './SettingsPage.module.css'

type Notice = { tone: 'info' | 'success' | 'error'; message: string }

// username과 화면 이름(displayUsername)을 같은 값으로 보냅니다. 서버가 소문자로 저장하고 중복을 확인합니다.
export function UsernameForm({ current }: { current: string }) {
  const router = useRouter()
  const [value, setValue] = useState(current)
  const [fieldError, setFieldError] = useState<string | undefined>()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = normalizeUsername(value)
    const invalid = usernameError(next)
    setFieldError(invalid)
    setNotice(null)
    if (invalid) return
    if (next === current) {
      setNotice({ tone: 'info', message: '현재 username과 같습니다.' })
      return
    }

    setPending(true)
    try {
      const { error } = await authClient.updateUser({ username: next, displayUsername: next })
      if (error) {
        setNotice({ tone: 'error', message: usernameErrorMessage(error) })
        return
      }
      setNotice({ tone: 'success', message: `username을 ${next}(으)로 바꿨습니다. 다음 로그인부터 새 username을 사용하세요.` })
      router.refresh()
    } catch {
      // HTTP 오류는 error로 오지만 네트워크 오류는 예외로 옵니다.
      setNotice({ tone: 'error', message: NO_RESPONSE_MESSAGE })
    } finally {
      setPending(false)
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField
        label="새 username"
        name="username"
        autoComplete="username"
        required
        hint={`${USERNAME_RULE_MESSAGE} 로그인할 때는 대소문자를 구분하지 않습니다.`}
        error={fieldError}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {notice ? <FormNotice tone={notice.tone}>{notice.message}</FormNotice> : null}
      <div className={styles.formActions}>
        <Button type="submit" disabled={pending}>
          {pending ? '변경 중…' : 'username 변경'}
        </Button>
      </div>
    </form>
  )
}
