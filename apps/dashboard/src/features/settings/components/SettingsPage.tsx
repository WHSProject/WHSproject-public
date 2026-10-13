import { providerLabel } from '@/lib/auth/common/labels'
import { formatDateTime } from '@/lib/format'

import type { SessionRow } from '../types/account'
import { NpmTokenPanel } from './NpmTokenPanel'
import { PasswordForm } from './PasswordForm'
import { SessionsTable } from './SessionsTable'
import styles from './SettingsPage.module.css'
import { UsernameForm } from './UsernameForm'

export type SettingsProfile = {
  displayName: string
  roleName: string
  providers: string[]
  createdAt: string
}

type SettingsPageProps = {
  profile: SettingsProfile
  sessions: SessionRow[]
  npmTokenExpiresAt?: string | null
  canInstall?: boolean
}

// 로그인한 본인의 정보만 보여 주고 바꿉니다. 역할은 Admin만 바꾸고, 이메일은 자동값이라 보여 주지 않습니다.
export function SettingsPage({ profile, sessions, npmTokenExpiresAt = null, canInstall = false }: SettingsPageProps) {
  const hasPassword = profile.providers.includes('credential')

  return (
    <div className={styles.page}>
      <section className={styles.panel} aria-labelledby="settings-title">
        <p className={styles.eyebrow}>ACCOUNT · SETTINGS</p>
        <h1 id="settings-title" className={styles.title} aria-label="개인 설정">Setting</h1>
        <p className={styles.description}>내 계정 정보와 username·비밀번호, 로그인된 기기를 관리합니다.</p>
      </section>

      <div className={styles.settingsGrid}>
      <section className={styles.panel} aria-labelledby="settings-profile-title">
        <h2 id="settings-profile-title" className={styles.sectionTitle}>내 정보</h2>
        <dl className={styles.details}>
          <dt>username</dt>
          <dd>{profile.displayName}</dd>
          <dt>권한</dt>
          <dd>
            {profile.roleName}
            <span className={styles.hint}>권한은 Admin이 바꿉니다.</span>
          </dd>
          <dt>로그인 수단</dt>
          <dd>{profile.providers.length > 0 ? profile.providers.map(providerLabel).join(', ') : '-'}</dd>
          <dt>가입일</dt>
          <dd className={styles.mono}>{formatDateTime(profile.createdAt)}</dd>
        </dl>
      </section>

      <section className={styles.panel} aria-labelledby="settings-username-title">
        <h2 id="settings-username-title" className={styles.sectionTitle}>username 변경</h2>
        <div className={styles.stack}>
          <UsernameForm current={profile.displayName} />
        </div>
      </section>

      <NpmTokenPanel expiresAt={npmTokenExpiresAt} canInstall={canInstall} />

      <section className={styles.panel} aria-labelledby="settings-password-title">
        <h2 id="settings-password-title" className={styles.sectionTitle}>비밀번호 변경</h2>
        <div className={styles.stack}>
          {hasPassword ? (
            <PasswordForm />
          ) : (
            <p className={styles.muted}>비밀번호로 로그인하지 않는 계정입니다. 비밀번호 설정은 Admin에게 문의하세요.</p>
          )}
        </div>
      </section>

      </div>

      <section className={styles.panel} aria-labelledby="settings-sessions-title">
        <h2 id="settings-sessions-title" className={styles.sectionTitle}>로그인된 기기</h2>
        <SessionsTable sessions={sessions} />
      </section>
    </div>
  )
}
