import Link from 'next/link'

import { AUTH_ROUTES, LOGIN_NOTICES, type LoginNotice } from '@/lib/auth/common/routes'
import { FormNotice } from '@/components/ui/FormNotice'

import { AuthCard } from './AuthCard'
import styles from './AuthForm.module.css'
import { LoginForm } from './LoginForm'
import { ResetPasswordForm } from './ResetPasswordForm'

const backToLogin = <Link href={AUTH_ROUTES.login}>로그인으로 돌아가기</Link>

type LoginPageProps = {
  callbackURL: string
  notice?: LoginNotice
}

export function LoginPage({ callbackURL, notice }: LoginPageProps) {
  return (
    <AuthCard
      title="로그인"
      description="ARGUS Dashboard 계정은 Admin이 만듭니다."
    >
      <div className={styles.stack}>
        {notice ? <FormNotice tone="success">{LOGIN_NOTICES[notice]}</FormNotice> : null}
        <LoginForm callbackURL={callbackURL} />
        {/* 재설정 요청 화면은 없고, 관리자가 재설정 링크를 발급합니다. */}
        <p className={styles.hint}>비밀번호를 잊으셨다면 관리자에게 문의하세요.</p>
      </div>
    </AuthCard>
  )
}

// Admin이 발급한 링크로 들어옵니다. 새 계정의 첫 비밀번호 설정도 이 화면입니다.
export function ResetPasswordPage({ token, error }: { token?: string; error?: string }) {
  if (!token || error) {
    return (
      <AuthCard title="링크를 사용할 수 없습니다" footer={backToLogin}>
        <FormNotice tone="error">링크가 만료되었거나 이미 사용되었습니다. Admin에게 새 링크를 요청하세요.</FormNotice>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="새 비밀번호 설정" description="새 비밀번호를 입력하세요." footer={backToLogin}>
      <ResetPasswordForm token={token} />
    </AuthCard>
  )
}
