'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useState } from 'react'

import { DEFAULT_ROLE } from '@/lib/auth/common/permissions'
import type { RoleOption } from '@/lib/auth/common/roles'
import { normalizeUsername } from '@/lib/auth/common/username'
import { usernameError } from '@/lib/auth/common/validation'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { TextField } from '@/components/ui/TextField'

import { ADMIN_API, sendAdminRequest } from '../api/admin'
import { ADMIN_REQUEST_FAILED_MESSAGE } from '../model/errors'
import type { PasswordLink } from '../types/users'
import styles from './AdminPage.module.css'
import { PasswordLinkNotice } from './PasswordLinkNotice'

// 계정 생성: username과 역할을 정하면 비밀번호 설정 링크가 나옵니다. 이메일은 입력받지 않습니다.
export function CreateUserForm({ roles }: { roles: RoleOption[] }) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [role, setRole] = useState<string>(DEFAULT_ROLE)
  const [fieldError, setFieldError] = useState<string>()
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ username: string; link: PasswordLink } | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = normalizeUsername(username)
    const invalid = usernameError(name)
    setFieldError(invalid)
    if (invalid) return

    setPending(true)
    setError(null)
    setCreated(null)
    const result = await sendAdminRequest<PasswordLink>(ADMIN_API.users, 'POST', { username: name, role })
    setPending(false)

    if (!result.ok || !result.data) {
      setError(result.ok ? ADMIN_REQUEST_FAILED_MESSAGE : result.message)
      return
    }
    setCreated({ username: name, link: result.data })
    setUsername('')
    setRole(DEFAULT_ROLE)
    router.refresh()
  }

  return (
    <div className={styles.stack}>
      <form className={styles.createForm} onSubmit={handleSubmit}>
        <TextField
          label="username"
          name="username"
          autoComplete="off"
          required
          hint="영문·숫자·_ 3~30자. 로그인과 npm에 쓰는 이름입니다."
          error={fieldError}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label className={styles.selectField}>
          권한
          <select className={styles.select} name="role" value={role} disabled={pending} onChange={(event) => setRole(event.target.value)}>
            {roles.map((option) => (
              <option key={option.code} value={option.code}>{option.name}</option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? '만드는 중…' : '계정 만들기'}
        </Button>
      </form>
      {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      {created ? (
        <PasswordLinkNotice
          message={`${created.username} 계정을 만들었습니다. 아래 링크를 전달하면 사용자가 비밀번호를 설정하고 로그인할 수 있습니다.`}
          link={created.link}
        />
      ) : null}
    </div>
  )
}
