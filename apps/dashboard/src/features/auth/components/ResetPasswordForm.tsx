'use client'

import Link from 'next/link'
import { type FormEvent, useState } from 'react'

import { authClient } from '@/lib/auth/client'
import { AUTH_ROUTES } from '@/lib/auth/common/routes'
import { PASSWORD_RULE_MESSAGE, passwordConfirmError, passwordError } from '@/lib/auth/common/validation'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'

import { type AuthErrorLike, resetPasswordErrorMessage } from '../model/errors'
import styles from './AuthForm.module.css'

type FieldErrors = { password?: string; passwordConfirm?: string }

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<AuthErrorLike>(null)
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = { password: passwordError(password), passwordConfirm: passwordConfirmError(password, passwordConfirm) }
    setFieldErrors(errors)
    if (errors.password || errors.passwordConfirm) return

    setPending(true)
    setError(null)
    const { error: resetError } = await authClient.resetPassword({ newPassword: password, token })
    if (resetError) setError(resetError)
    else setDone(true)
    setPending(false)
  }

  if (done) {
    return (
      <FormNotice tone="success">
        비밀번호를 저장했습니다. 다른 기기의 로그인은 모두 해제되었습니다.{' '}
        <Link href={AUTH_ROUTES.login}>로그인하기</Link>
      </FormNotice>
    )
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField
        label="새 비밀번호"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={PASSWORD_RULE_MESSAGE}
        error={fieldErrors.password}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
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
      {error ? <FormNotice tone="error">{resetPasswordErrorMessage(error)}</FormNotice> : null}
      <Button type="submit" disabled={pending}>
        {pending ? '저장 중…' : '비밀번호 저장'}
      </Button>
    </form>
  )
}
