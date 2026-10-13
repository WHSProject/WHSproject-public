import Link from 'next/link'

import { DecisionChip } from '@/components/decision'
import { DECISIONS, type Decision } from '@/lib/decision/types'
import { formatDateTime } from '@/lib/format'
import { policyErrorMessage } from '@/lib/policy/common/errors'

import type { ActivePolicyCard, OverviewData } from '../types/overview'
import styles from './OverviewPage.module.css'
import { PackageRatioCard } from './PackageRatioCard'

const decisionStyles: Record<Decision, string> = {
  ACCEPT: styles.accept,
  REJECT: styles.reject,
  HOLD: styles.hold,
  REVIEW: styles.review,
}

// 시간대별 건수를 104×30 추이선으로 그립니다. 가장 큰 값이 위쪽(y=6), 0이 아래쪽(y=26)입니다.
function sparklinePath(values: readonly number[]): string {
  const max = Math.max(1, ...values)
  const step = values.length > 1 ? 104 / (values.length - 1) : 0
  return values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${(index * step).toFixed(1)} ${(26 - (value / max) * 20).toFixed(1)}`).join(' ')
}

function Sparkline({ values }: { values: readonly number[] }) {
  const path = sparklinePath(values)
  const lastY = path.split(' ').at(-1)
  return (
    <svg className={styles.sparkline} viewBox="0 0 104 30" width="104" height="30" aria-hidden="true">
      <path d={`${path} L 104 30 L 0 30 Z`} fill="currentColor" fillOpacity="0.08" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="104" cy={lastY} r="3" fill="currentColor" />
    </svg>
  )
}

function PolicyCard({ policy, canViewPolicy }: { policy: ActivePolicyCard; canViewPolicy: boolean }) {
  if (policy.status !== 'ready') {
    return (
      <article className={styles.kpiCard}>
        <h2 className={styles.kpiLabel}>적용 중 정책</h2>
        <p className={styles.policyNote}>
          {policy.status === 'no-policy' ? '적용 중인 정책이 없습니다.' : policyErrorMessage(policy.code)}
        </p>
      </article>
    )
  }
  return (
    <article className={styles.kpiCard}>
      <h2 className={styles.kpiLabel}>적용 중 정책</h2>
      <div className={styles.policyVersion}>v{policy.version}</div>
      <div className={styles.policyDescription}>사용 중 Rule {policy.enabledRules}개</div>
      <div className={styles.policyDescription}>적용 {policy.appliedBy}</div>
      {canViewPolicy ? (
        <div className={styles.policyLinks}><Link href="/rules">Rule</Link><Link href="/versions">Version</Link></div>
      ) : null}
    </article>
  )
}

// 최근 24시간 현황(설치 요청·판정·미승인), 적용 중 정책, 판정 분포, 최근 판정, 판정 방식 안내
export function OverviewPage({ data, canViewPolicy }: { data: OverviewData; canViewPolicy: boolean }) {
  const { installRequests, installError, decisions, decisionError, policy, recent } = data
  const notAccepted = decisions.total - decisions.byDecision.ACCEPT

  return (
    <div className={styles.page}>
      {decisionError ? <p role="alert" className={styles.policyNote}>판정 현황을 불러오지 못했습니다. Decision DB 연결을 확인해 주세요. ({decisionError})</p> : null}
      <section aria-labelledby="overview-title">
        <div className={styles.summaryHeading}>
          <div><h1 id="overview-title">Overview</h1>
            <p className={styles.description}>{decisionError ? '최근 24시간의 판정 현황을 불러오지 못했습니다.' : <>최근 24시간의 설치 요청에서 <strong>{notAccepted}</strong>개의 미승인 패키지를 확인했습니다.</>}</p>
          </div>
          <span className={styles.period}>최근 24시간</span>
        </div>
        <div className={styles.kpiGrid}>
          <article className={styles.kpiCard}>
            <h2 className={styles.kpiLabel}>설치 요청</h2>
            {installError ? (
              <p role="alert" className={styles.policyNote}>설치 요청을 불러오지 못했습니다. ({installError})</p>
            ) : <>
              <div className={styles.kpiValue}><strong>{installRequests.total}</strong><span>건</span></div>
              <Sparkline values={installRequests.hourly} />
            </>}
          </article>
          <article className={styles.kpiCard}>
            <h2 className={styles.kpiLabel}>판정</h2>
            <div className={styles.kpiValue}><strong>{decisions.total}</strong><span>건</span></div>
            <Sparkline values={decisions.hourly.map((bucket) => bucket.total)} />
          </article>
          <PackageRatioCard total={decisions.total} notAccepted={notAccepted} />
          <PolicyCard policy={policy} canViewPolicy={canViewPolicy} />
        </div>
      </section>

      <div className={styles.bodyGrid}>
      <section className={styles.panel} aria-labelledby="recent-title">
        <div className={styles.sectionHeading}>
          <h2 id="recent-title">최근 판정</h2>
          <Link className={styles.more} href="/packages">전체 보기</Link>
        </div>
        {recent.length === 0 ? (
          <p className={styles.empty}>아직 판정이 없습니다.</p>
        ) : (
          <div className={styles.tableScroll} role="region" aria-label="최근 판정 목록" tabIndex={0}>
            <table className={styles.recentTable} aria-labelledby="recent-title">
              <thead><tr>
                <th scope="col">판정</th><th scope="col">설치 시도 사용자</th><th scope="col">패키지</th>
                <th scope="col">트리거된 Rule</th><th scope="col">판정 시각</th>
              </tr></thead>
              <tbody>
                {recent.map((item) => (
                  <tr key={item.decisionId} className={item.decision === 'REJECT' ? styles.rejectedRow : undefined}>
                    <td><DecisionChip decision={item.decision} /></td>
                    <td>{item.username ?? '-'}</td>
                    <td>
                      <Link className={styles.packageName} href={`/packages?selected=${encodeURIComponent(item.decisionId)}`} title={`${item.packageName} ${item.version}`}>
                        {item.packageName}<span>{item.version}</span>
                      </Link>
                    </td>
                    <td className={styles.rule} title={item.triggeredRule?.name}>
                      {item.triggeredRule ? (
                        <>{item.triggeredRule.name}{item.triggeredRule.others > 0 ? <span> 외 {item.triggeredRule.others}개</span> : null}</>
                      ) : <span>해당 Rule 없음</span>}
                    </td>
                    <td className={styles.number}>{formatDateTime(item.evaluatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className={styles.support}>
        <section className={styles.panel} aria-labelledby="distribution-title">
          <h2 className={styles.guideHeading} id="distribution-title">판정 분포<span>LAST 24 HOURS</span></h2>
          {decisions.total === 0 ? (
            <p className={styles.empty}>최근 24시간 판정이 없습니다.</p>
          ) : (
            DECISIONS.map((decision) => {
              const count = decisions.byDecision[decision]
              const percent = Math.round(count / decisions.total * 100)
              return (
                <div className={styles.distributionRow} key={decision}>
                  <DecisionChip decision={decision} />
                  <div className={styles.bar} role="img" aria-label={`${decision} ${count}건 ${percent}%`}>
                    <span className={decisionStyles[decision]} style={{ width: `${count / decisions.total * 100}%` }} />
                  </div>
                  <span className={styles.number}>{count}건 · {percent}%</span>
                </div>
              )
            })
          )}
        </section>
        <section className={styles.panel} aria-labelledby="trend-title">
          <h2 className={styles.guideHeading} id="trend-title">시간대별 판정<span>24H · KST</span></h2>
          <div className={styles.trendLegend}><span className={styles.accept}>승인</span><span className={styles.reject}>미승인</span></div>
          <svg className={styles.trendChart} viewBox="0 0 336 72" role="img" aria-label="최근 24시간 판정 추이">
            <path d="M0 14H336 M0 40H336 M0 66H336" fill="none" stroke="var(--color-border)" />
            {decisions.hourly.map((bucket, index) => {
              const max = Math.max(1, ...decisions.hourly.map((hour) => hour.total))
              const step = 336 / Math.max(1, decisions.hourly.length)
              const accepted = (bucket.total - bucket.notAccepted) / max * 52
              const unapproved = bucket.notAccepted / max * 52
              return <g key={bucket.hour}><title>{`${formatDateTime(bucket.hour)} · 승인 ${bucket.total - bucket.notAccepted}건 · 미승인 ${bucket.notAccepted}건`}</title>
                <rect x={index * step + step * .15} y={66 - accepted} width={step * .65} height={accepted} fill="var(--decision-accept)" />
                <rect x={index * step + step * .15} y={66 - accepted - unapproved} width={step * .65} height={unapproved} fill="var(--decision-reject)" />
              </g>
            })}
          </svg>
          <p className={styles.trendNote}>미승인 = <span className={styles.reject}>REJECT</span> · <span className={styles.hold}>HOLD</span> · <span className={styles.review}>REVIEW</span></p>
        </section>
      </div>
      </div>
        <section className={styles.panel} aria-labelledby="method-title">
          <h2 className={styles.guideHeading} id="method-title">판정 방식<span>HOW DECISIONS ARE MADE</span></h2>
          <ol className={styles.method}>
            <li>조건이 맞는 <strong className={styles.reject}>REJECT</strong> Rule이 하나라도 있으면 우선순위와 관계없이 <strong className={styles.reject}>REJECT</strong>입니다.</li>
            <li>근거끼리 충돌하면 <strong className={styles.review}>REVIEW</strong>입니다.</li>
            <li>조건을 판단할 수 없거나 분석이 끝나지 않았으면 <strong className={styles.holdText}>HOLD</strong>입니다. 판단 불가 시 <strong className={styles.review}>REVIEW</strong>로 정한 Rule이 있으면 <strong className={styles.review}>REVIEW</strong>입니다.</li>
            <li>그 밖에는 조건이 맞는 Rule 중 <strong>우선순위가 가장 높은 Rule</strong>의 판정이고, 맞는 Rule이 없으면 <strong className={styles.review}>REVIEW</strong>입니다.</li>
            <li>적용 정책 버전이 바뀌어도 이미 내려진 판정은 다시 계산하지 않고 재사용합니다.</li>
          </ol>
        </section>
    </div>
  )
}
