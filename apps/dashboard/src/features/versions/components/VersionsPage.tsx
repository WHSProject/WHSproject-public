'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import { formatDateTime } from '@/lib/format'
import type { PolicyVersion, PolicyVersionSummary } from '@/lib/policy/common/types'

import { activateVersionRequest } from '../api/versions'
import { VERSION_STATE_LABELS, type VersionState, versionState } from '../model/versions'
import { VersionRules } from './VersionRules'
import styles from './VersionsPage.module.css'

export type VersionsPageProps = {
  policyKey: string
  activeVersion: string
  versions: PolicyVersionSummary[]
  /** Rule을 보고 있는 버전(주소의 ?view=, 없으면 적용 중 버전) */
  viewed: PolicyVersion
  canApply: boolean
}

const NOT_APPLICABLE_REASONS: Partial<Record<VersionState, string>> = {
  blocked: '이전 Policy 내부 버전이라 다시 적용할 수 없습니다.',
  draft: '적용된 적 없는 초안이라 적용할 수 없습니다. 같은 내용이 필요하면 Rule 페이지에서 다시 적용하세요.',
}

const viewHref = (version: string) => `/versions?view=${encodeURIComponent(version)}`

// 버전 목록에서 버전을 골라 Rule을 보고, 보고 있는 버전이 적용 가능하면 다시 적용합니다(무엇으로 되돌리는지 보고 적용).
// 적용이 끝나면 page.tsx가 적용 중 버전을 key로 이 화면을 다시 만듭니다.
export function VersionsPage({ policyKey, activeVersion, versions, viewed, canApply }: VersionsPageProps) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewedSection = useRef<HTMLElement>(null)
  const shownVersion = useRef<string | null>(null)

  // 'Rule 보기'로 버전을 바꾸면(또는 ?view=로 들어오면) 아래 Rule 영역으로 부드럽게 내려가 바뀐 내용을 보여 줍니다.
  useEffect(() => {
    const first = shownVersion.current === null
    shownVersion.current = viewed.version
    if (first && !new URLSearchParams(window.location.search).has('view')) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    viewedSection.current?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
    viewedSection.current?.focus({ preventScroll: true })
  }, [viewed.version])

  const active = versions.find((item) => item.version === activeVersion)
  const viewedSummary = versions.find((item) => item.version === viewed.version)
  const viewedState: VersionState = viewedSummary ? versionState(viewedSummary, activeVersion) : 'active'
  const canSubmit = canApply && viewedState === 'applicable' && !pending

  async function activate() {
    if (!canSubmit) return
    setPending(true)
    setError(null)
    const result = await activateVersionRequest(policyKey, viewed.version, activeVersion)
    setPending(false)
    setConfirming(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    router.push('/versions')
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}>
        <h1 id="versions-title" className={styles.title}>Version</h1>
        <p>정책 버전 이력을 확인하고 이전 Rule 구성을 검토합니다.</p>
      </div>
      <section className={styles.panel} aria-labelledby="versions-title">
        <p className={styles.description}>
          지금 적용 중: <strong>v{activeVersion}</strong>
          {active ? ` · ${active.updatedBy} · ${formatDateTime(active.publishedAt)}` : null}
          <span className={styles.policyName}>{viewed.name}</span>
        </p>

        <div className={styles.tableScroll} role="region" aria-label="정책 버전 목록" tabIndex={0}>
          <table className={styles.table} aria-label="정책 버전">
            <thead>
              <tr>
                <th scope="col">버전</th>
                <th scope="col">상태</th>
                <th scope="col">만든 사람</th>
                <th scope="col">만든 시각</th>
                <th scope="col">마지막 적용</th>
                <th scope="col">Rule</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((item) => {
                const state = versionState(item, activeVersion)
                const viewing = item.version === viewed.version
                return (
                  <tr key={item.version} className={viewing ? styles.viewingRow : undefined} aria-current={viewing ? 'true' : undefined}>
                    <td className={styles.mono}>v{item.version}</td>
                    <td><span className={`${styles.state} ${styles[state]}`}>{VERSION_STATE_LABELS[state]}</span></td>
                    <td>{item.createdBy}</td>
                    <td className={styles.mono}>{formatDateTime(item.createdAt)}</td>
                    <td className={styles.mono}>{formatDateTime(item.publishedAt)}</td>
                    <td>
                      {viewing ? (
                        <span className={styles.muted}>보는 중</span>
                      ) : (
                        <Link className={styles.link} href={viewHref(item.version)} scroll={false} aria-label={`v${item.version} Rule 보기`}>Rule 보기</Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section ref={viewedSection} tabIndex={-1} className={`${styles.panel} ${styles.viewedPanel}`} aria-labelledby="viewed-title">
        <div className={styles.viewHead}>
          <div>
            <h2 id="viewed-title" className={styles.panelHeading}>v{viewed.version} Rule</h2>
            <p className={styles.panelCaption}>Rule {viewed.rules.length}개 · {VERSION_STATE_LABELS[viewedState]}</p>
          </div>
          {canApply && viewedState === 'applicable' ? (
            <Button onClick={() => setConfirming(true)} disabled={!canSubmit}>이 버전 적용</Button>
          ) : null}
        </div>
        {NOT_APPLICABLE_REASONS[viewedState] ? <p className={styles.note}>{NOT_APPLICABLE_REASONS[viewedState]}</p> : null}

        {confirming ? (
          <div className={styles.confirm} role="alertdialog" aria-label="적용 확인">
            <p>
              v{viewed.version}의 Rule로 바로 판정합니다. 지금 버전 v{activeVersion}은 보관됩니다.
              <br />
              이미 판정된 패키지에는 적용되지 않습니다(기존 판정 재사용).
            </p>
            <Button onClick={() => void activate()} disabled={!canSubmit}>{pending ? '적용 중…' : '적용 확인'}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>돌아가기</Button>
          </div>
        ) : null}
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}

        <VersionRules rules={viewed.rules} />
      </section>
    </div>
  )
}
