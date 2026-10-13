import type { ReactNode } from 'react'

import { ThemeToggle } from '@/components/ui/ThemeToggle/ThemeToggle'

import styles from './AuthCard.module.css'

type AuthCardProps = {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}

// 로그인·가입 등 인증 화면의 공통 틀입니다. 색·간격은 tokens.css 변수만 사용합니다.
export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <main className={styles.page}>
      <header className={styles.topbar}><span>ARGUS / Account access</span><ThemeToggle /></header>
      <section className={styles.card} aria-labelledby="auth-title">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">A</span>
          <span>
            <strong>ARGUS</strong>
            <small>SUPPLY CHAIN</small>
          </span>
        </div>
        <h1 id="auth-title" className={styles.title}>{title}</h1>
        {description ? <p className={styles.description}>{description}</p> : null}
        <div className={styles.body}>{children}</div>
        {footer ? <nav className={styles.footer} aria-label="다른 인증 화면">{footer}</nav> : null}
      </section>
    </main>
  )
}
