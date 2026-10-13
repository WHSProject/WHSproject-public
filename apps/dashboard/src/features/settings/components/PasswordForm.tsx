'use client'

import { type FormEvent, useState } from 'react'

import { authClient } from '@/lib/auth/client'
import { AUTH_ROUTES, type LoginNotice } from '@/lib/auth/common/routes'
import { PASSWORD_RULE_MESSAGE, passwordConfirmError, passwordError } from '@/lib/auth/common/validation'
import { hardNavigate } from '@/lib/navigation'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'

import { NO_RESPONSE_MESSAGE, passwordChangeErrorMessage } from '../model/errors'
import styles from './SettingsPage.module.css'

type FieldErrors = { newPassword?: string; passwordConfirm?: string }

const PASSWORD_CHANGED: LoginNotice = 'password-changed'

// 비밀번호를 바꾸면 서버가 이 기기를 포함한 모든 세션을 끊습니다. 로그인 화면으로 이동해 새 비밀번호로 다시 로그인합니다.
export function PasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors: FieldErrors = {
      newPassword:
        passwordError(newPassword) ??
        (newPassword === currentPassword ? '새 비밀번호가 현재 비밀번호와 같습니다.' : undefined),
      passwordConfirm: passwordConfirmError(newPassword, passwordConfirm),
    }
    setFieldErrors(errors)
    setFormError(null)
    if (errors.newPassword || errors.passwordConfirm) return

    setPending(true)
    try {
      const { error } = await authClient.changePassword({ currentPassword, newPassword })
      if (!error) {
        // 성공하면 로그인 화면으로 이동하므로 버튼은 비활성으로 둡니다.
        hardNavigate(`${AUTH_ROUTES.login}?notice=${PASSWORD_CHANGED}`)
        return
      }
      setFormError(passwordChangeErrorMessage(error))
    } catch {
      // 네트워크 오류는 예외로 옵니다. 서버에서는 바뀌었을 수 있으므로 새로고침해 확인하게 합니다.
      setFormError(NO_RESPONSE_MESSAGE)
    }
    setPending(false)
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <p className={styles.notice}>변경하면 이 기기를 포함한 모든 기기에서 로그아웃되고, 새 비밀번호로 다시 로그인해야 합니다.</p>
      <TextField
        label="현재 비밀번호"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        value={currentPassword}
        onChange={(event) => setCurrentPassword(event.target.value)}
      />
      <TextField
        label="새 비밀번호"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        required
        hint={PASSWORD_RULE_MESSAGE}
        error={fieldErrors.newPassword}
        value={newPassword}
        onChange={(event) => setNewPassword(event.target.value)}
      />
      <TextField
        label="새 비밀번호 확인"
        name="passwordConfirm"
        type="password"
        autoComplete="new-password"
        required
        error={fieldErrors.passwordConfirm}
        value={passwordConfirm}
        onChange={(event) => setPasswordConfirm(event.target.value)}
      />
      {formError ? <FormNotice tone="error">{formError}</FormNotice> : null}
      <div className={styles.formActions}>
        <Button type="submit" disabled={pending}>
          {pending ? '변경 중…' : '비밀번호 변경'}
        </Button>
      </div>
    </form>
  )
}
