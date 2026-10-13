'use client'

import { type FormEvent, useState } from 'react'

import { authClient } from '@/lib/auth/client'
import { normalizeUsername } from '@/lib/auth/common/username'
import { hardNavigate } from '@/lib/navigation'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'

import { type AuthErrorLike, loginErrorMessage } from '../model/errors'
import styles from './AuthForm.module.css'

export function LoginForm({ callbackURL }: { callbackURL: string }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<AuthErrorLike>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    // username으로만 로그인합니다. 이메일 로그인은 서버에서도 막혀 있습니다.
    const { error: signInError } = await authClient.signIn.username({ username: normalizeUsername(username), password })

    if (signInError) {
      setError(signInError)
      setPending(false)
      return
    }
    hardNavigate(callbackURL)
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField
        label="username"
        name="username"
        autoComplete="username"
        required
        value={username}
        onChange={(event) => setUsername(event.target.value)}
      />
      <TextField
        label="비밀번호"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      {error ? <FormNotice tone="error">{loginErrorMessage(error)}</FormNotice> : null}
      <Button type="submit" disabled={pending}>
        {pending ? '로그인 중…' : '로그인'}
      </Button>
    </form>
  )
}
