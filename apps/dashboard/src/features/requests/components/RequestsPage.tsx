'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

import { DecisionChip, DecisionFilter } from '@/components/decision'
import { SearchField } from '@/components/ui/SearchField'
import { useAddressSearch } from '@/components/ui/SearchField/useAddressSearch'
import type { Decision, DecisionFilterValue } from '@/lib/decision/types'
import { outcomeLabel, type RootRequest } from '@/lib/download-events/types'

import { requestsHref } from '../model/query'
import type { RequestSearch, RequestsPageData } from '../types/requests'
import styles from './RequestsPage.module.css'

const decisionStyles: Record<Decision, string> = {
  ACCEPT: styles.accept,
  REJECT: styles.reject,
  HOLD: styles.hold,
  REVIEW: styles.review,
}

// 시각은 서버·브라우저 모두 한국 시간으로 표시합니다.
const time = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export type RequestsPageProps = { search: RequestSearch; data: RequestsPageData }

// 루트 패키지 요청 한 줄. 판정이 있으면 그 판정의 Package 상세로 연결합니다(판정 전에 끝난 요청은 연결 없음).
function RequestRow({ item }: { item: RootRequest }) {
  const className = `${styles.row} ${item.decision === 'REJECT' ? styles.rejectedRow : ''}`
  const content = (
    <>
      <span className={styles.time}>{time.format(new Date(item.occurredAt))}</span>
      <span className={`${styles.marker} ${item.decision ? decisionStyles[item.decision] : styles.neutral}`} aria-hidden="true">
        <span className={styles.dot} />
      </span>
      <span className={styles.body}>
        <span className={styles.titleLine}>
          <strong className={styles.name}>{item.packageName}</strong>
          <span className={styles.version}>{item.version}</span>
          {item.decision ? <DecisionChip decision={item.decision} /> : <span className={styles.outcome}>{outcomeLabel(item.outcome, item.decision)}</span>}
        </span>
        <span className={styles.metaLine}>
          <span>{item.username ?? '인증되지 않은 요청'}</span>
          {item.decision ? <><span aria-hidden="true">·</span><span>{outcomeLabel(item.outcome, item.decision)}</span></> : null}
        </span>
      </span>
    </>
  )
  return (
    <li>
      {item.decisionId ? (
        <Link className={`${className} ${styles.link}`} href={`/packages?selected=${encodeURIComponent(item.decisionId)}`}>{content}</Link>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  )
}

// 최근 7일 루트 패키지 요청(사용자가 직접 설치한 패키지)을 날짜별로 보여 줍니다. 검색·판정 필터는 주소 값이고 서버가 조회합니다.
export function RequestsPage({ search, data }: RequestsPageProps) {
  const router = useRouter()
  const { query, change, take } = useAddressSearch(search.q, (q) =>
    router.replace(requestsHref({ q, decision: search.decision }), { scroll: false }))

  function handleFilter(decision: DecisionFilterValue) {
    router.push(requestsHref({ q: take(), decision }), { scroll: false })
  }

  const filtered = search.q !== '' || search.decision !== 'ALL'

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}><h1 id="request-list-title" aria-label="설치 요청 목록">Request</h1><p>사용자가 직접 설치한 루트 패키지 요청을 날짜별로 확인합니다.</p></div>
      <section className={styles.panel} aria-labelledby="request-list-title">
        <div className={styles.searchBar}>
          <SearchField value={query} onChange={change} placeholder="루트 패키지 또는 사용자로 검색" />
          <DecisionFilter value={search.decision} onChange={handleFilter} />
        </div>
        {'error' in data ? (
          <p role="alert" className={styles.empty}>설치 요청을 불러오지 못했습니다. DB 연결을 확인해 주세요. ({data.error})</p>
        ) : <>
          <p className={styles.summary}>최근 7일 루트 패키지 설치 요청 {data.total}건</p>
          {data.days.length === 0 ? (
            <p className={styles.empty}>{filtered ? '조건에 맞는 설치 요청이 없습니다.' : '최근 7일 동안 설치 요청이 없습니다.'}</p>
          ) : (
            data.days.map((day) => (
              <section className={styles.group} key={day.date} aria-label={day.label}>
                <h3 className={styles.groupHeading}>{day.label}<span>{day.date.replaceAll('-', '.')}</span></h3>
                <ul className={styles.timeline}>
                  {day.items.map((item) => <RequestRow key={item.requestId} item={item} />)}
                </ul>
              </section>
            ))
          )}
        </>}
      </section>
    </div>
  )
}
