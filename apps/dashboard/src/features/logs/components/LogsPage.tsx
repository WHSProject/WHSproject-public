'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FormEvent, MouseEvent } from 'react'

import { DecisionChip } from '@/components/decision'
import { Button } from '@/components/ui/Button'
import { SearchField } from '@/components/ui/SearchField'
import { useAddressSearch } from '@/components/ui/SearchField/useAddressSearch'
import type { Decision } from '@/lib/decision/types'
import { type DownloadOutcome, LOG_PAGE_SIZE, outcomeLabel } from '@/lib/download-events/types'
import { formatDateTime } from '@/lib/format'

import { ANONYMOUS_USER, logsHref, normalizeTraceValue } from '../model/query'
import type { LogRootDetail, LogSearch, LogsPageData, LogTrace, LogView } from '../types/logs'
import styles from './LogsPage.module.css'

const outcomeStyles: Record<DownloadOutcome, string> = {
  DELIVERED: styles.delivered,
  FORBIDDEN: styles.neutral,
  BLOCKED: styles.blocked,
  UNAUTHENTICATED: styles.neutral,
  ERROR: styles.neutral,
}

// 판정 전에 차단된 요청("판정 대기")은 차단 색을 쓰지 않습니다.
const outcomeClass = (outcome: DownloadOutcome, decision: Decision | null) =>
  outcome === 'BLOCKED' && decision === null ? styles.neutral : outcomeStyles[outcome]

export function LogsPage({ search, data }: { search: LogSearch; data: LogsPageData }) {
  const router = useRouter()
  // 검색어가 바뀌면 결과 범위가 달라지므로 1페이지부터 봅니다.
  const { query, change, take } = useAddressSearch(search.q, (q) =>
    router.replace(logsHref({ ...search, q, page: 1 }), { scroll: false }))

  function go(update: Partial<LogSearch>) {
    router.push(logsHref({ ...search, q: take(), ...update }), { scroll: false })
  }
  // 사용자·기간을 바꾸면 1페이지부터 봅니다. 역추적 조회(onTrace)는 설치 기록의 페이지를 건드리지 않습니다.
  const handleFilter = (update: Partial<LogSearch>) => go({ ...update, page: 1 })

  // 탭·페이지 링크: 입력 중인 검색이 있으면 그 타이머를 취소하고 이번 이동에 담습니다.
  // 그대로 두면 늦게 실행된 검색이 이전 탭·페이지 주소로 이동을 덮어씁니다. 검색어가 바뀌었으면 1페이지부터 봅니다.
  // 새 탭 열기(보조 키·가운데 클릭)는 브라우저 기본 동작에 맡깁니다.
  function follow(event: MouseEvent<HTMLAnchorElement>, update: Partial<LogSearch>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const q = take()
    const next = { ...search, ...update, q }
    router.push(logsHref(q === search.q ? next : { ...next, page: 1 }), { scroll: false })
  }

  // 탭을 바꿔도 다른 탭의 주소 값(검색어·역추적 패키지·페이지 등)은 지우지 않습니다.
  const tabs: { view: LogView; label: string }[] = [
    { view: 'events', label: '설치 기록' },
    { view: 'trace', label: '의존성 역추적' },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}><h1 id="logs-title" aria-label="설치 기록">Log</h1><p>설치 요청의 판정과 전달 결과를 확인합니다.</p></div>
      <nav className={styles.tabs} aria-label="설치 기록 보기 방식">
        {tabs.map(({ view, label }) => (
          <Link
            key={view}
            href={logsHref({ ...search, view })}
            onClick={(event) => follow(event, { view })}
            scroll={false}
            className={view === search.view ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            aria-current={view === search.view ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>

      {search.view === 'events' ? (
        <EventsPanel search={search} log={data.log} query={query} onQuery={change} onFilter={handleFilter} onFollow={follow} />
      ) : (
        <TracePanel
          search={search}
          trace={data.trace}
          rootDetail={data.rootDetail}
          onTrace={(trace, traceVersion) => go({ trace, traceVersion, root: '' })}
        />
      )}
    </div>
  )
}

type EventsPanelProps = {
  search: LogSearch
  log: LogsPageData['log']
  query: string
  onQuery: (value: string) => void
  onFilter: (update: Partial<LogSearch>) => void
  onFollow: (event: MouseEvent<HTMLAnchorElement>, update: Partial<LogSearch>) => void
}

function EventsPanel({ search, log, query, onQuery, onFilter, onFollow }: EventsPanelProps) {
  const usernames = log && !('error' in log) ? log.usernames : []
  // 기간 밖 사용자도 주소의 선택값을 유지합니다.
  const options = search.user && search.user !== ANONYMOUS_USER && !usernames.includes(search.user)
    ? [...usernames, search.user] : usernames

  return (
    <section className={styles.panel} aria-labelledby="logs-title">
      <div className={styles.filters}>
        <SearchField value={query} onChange={onQuery} placeholder="패키지 이름 또는 버전으로 검색" />
        <label className={styles.field}>
          사용자
          <select className={styles.control} value={search.user} onChange={(event) => onFilter({ user: event.target.value })}>
            <option value="">전체</option>
            {options.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
            <option value={ANONYMOUS_USER}>로그인 안 함</option>
          </select>
        </label>
        <label className={styles.field}>
          시작일
          <input
            className={styles.control}
            type="date"
            value={search.from}
            max={search.to}
            onChange={(event) => onFilter({ from: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          종료일
          <input
            className={styles.control}
            type="date"
            value={search.to}
            min={search.from}
            onChange={(event) => onFilter({ to: event.target.value })}
          />
        </label>
      </div>

      {!log ? null : 'error' in log ? (
        <p className={styles.empty} role="alert">설치 기록을 불러오지 못했습니다. DB 연결을 확인해 주세요. ({log.error})</p>
      ) : log.events.length === 0 ? (
        search.page > 1 ? (
          <p className={styles.empty}>
            이 페이지에 기록이 없습니다.{' '}
            <Link className={styles.rootLink} href={logsHref({ ...search, page: 1 })} onClick={(event) => onFollow(event, { page: 1 })} scroll={false}>
              1페이지로 이동
            </Link>
          </p>
        ) : (
          <p className={styles.empty}>조건에 맞는 설치 기록이 없습니다.</p>
        )
      ) : (
        <>
          <div className={styles.tableScroll} role="region" aria-label="설치 기록 목록" tabIndex={0}>
            <table className={styles.table} aria-label="설치 기록">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">사용자</th>
                  <th scope="col">패키지</th>
                  <th scope="col">판정</th>
                  <th scope="col">결과</th>
                  <th scope="col">요청 IP</th>
                </tr>
              </thead>
              <tbody>
                {log.events.map((event) => (
                  <tr key={event.id}>
                    <td className={styles.mono}>{formatDateTime(event.occurredAt)}</td>
                    <td>{event.username ?? <span className={styles.muted}>로그인 안 함</span>}</td>
                    <td>
                      <span className={styles.packageName}>{event.packageName}</span>
                      <span className={styles.version}>@{event.version}</span>
                    </td>
                    <td>
                      {event.decision ? <DecisionChip decision={event.decision} /> : <span className={styles.muted}>미판정</span>}
                    </td>
                    <td className={outcomeClass(event.outcome, event.decision)}>
                      {outcomeLabel(event.outcome, event.decision)}
                    </td>
                    <td className={styles.mono}>{event.sourceIp ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <EventsPager search={search} count={log.events.length} hasNext={log.hasNext} onFollow={onFollow} />
        </>
      )}
    </section>
  )
}

// 전체 건수는 세지 않으므로 페이지 번호 대신 현재 범위와 이전·다음만 보여 줍니다.
type EventsPagerProps = {
  search: LogSearch
  count: number
  hasNext: boolean
  onFollow: (event: MouseEvent<HTMLAnchorElement>, update: Partial<LogSearch>) => void
}

function EventsPager({ search, count, hasNext, onFollow }: EventsPagerProps) {
  const first = (search.page - 1) * LOG_PAGE_SIZE + 1
  const prev = search.page - 1
  const next = search.page + 1
  return (
    <nav className={styles.pager} aria-label="설치 기록 페이지">
      {search.page > 1
        ? <Link href={logsHref({ ...search, page: prev })} onClick={(event) => onFollow(event, { page: prev })} scroll={false} rel="prev">이전</Link>
        : <span aria-disabled="true">이전</span>}
      <span>{first}–{first + count - 1}건</span>
      {hasNext
        ? <Link href={logsHref({ ...search, page: next })} onClick={(event) => onFollow(event, { page: next })} scroll={false} rel="next">다음</Link>
        : <span aria-disabled="true">다음</span>}
    </nav>
  )
}

type TracePanelProps = {
  search: LogSearch
  trace: LogTrace | null
  rootDetail: LogRootDetail | null
  onTrace: (trace: string, traceVersion: string) => void
}

// 패키지(하위 의존성 포함)가 들어 있던 과거 Root 설치를 찾고, 선택한 설치의 전체 의존성을 보여 줍니다.
function TracePanel({ search, trace, rootDetail, onTrace }: TracePanelProps) {
  const router = useRouter()

  // 행 어디를 눌러도 그 Root 설치의 전체 의존성을 엽니다. 키보드·새 탭 열기는 Root 패키지 링크가 맡고,
  // 링크를 직접 누르거나 글자를 드래그해 선택한 경우에는 행 이동을 하지 않습니다.
  function openRoot(event: MouseEvent<HTMLTableRowElement>, href: string) {
    if ((event.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return
    router.push(href, { scroll: false })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = normalizeTraceValue(String(form.get('trace')))
    if (name) onTrace(name, normalizeTraceValue(String(form.get('traceVersion'))))
  }

  return (
    <section className={styles.panel} aria-labelledby="trace-title">
      <h2 className={styles.heading} id="trace-title">의존성 역추적</h2>
      <p className={styles.hint}>패키지 이름을 정확히 입력하면, 그 패키지가 포함됐던 Root 설치와 설치한 사용자를 찾습니다. 기간 필터는 적용되지 않습니다.</p>
      <p className={styles.hint}>Root 설치로 기록된 설치만 검색됩니다.</p>
      {/* 입력란은 조회할 때만 주소를 바꿉니다. 주소의 값이 바뀌면(뒤로 가기 등) key로 입력란을 다시 만들어 맞춥니다. */}
      <form key={`${search.trace}\n${search.traceVersion}`} className={styles.filters} onSubmit={submit}>
        <label className={`${styles.field} ${styles.grow}`}>
          패키지 이름
          <input className={styles.control} name="trace" defaultValue={search.trace} required />
        </label>
        <label className={styles.field}>
          버전(선택)
          <input className={styles.control} name="traceVersion" defaultValue={search.traceVersion} />
        </label>
        <Button type="submit">조회</Button>
      </form>

      {trace && ('error' in trace ? (
        <p className={styles.empty} role="alert">의존성 역추적 결과를 불러오지 못했습니다. DB 연결을 확인해 주세요. ({trace.error})</p>
      ) : trace.installs.length === 0 ? (
        <p className={styles.empty}>이 패키지가 포함된 Root 설치 기록이 없습니다.</p>
      ) : (
        <>
          {trace.truncated && <p className={styles.empty}>최근 200건만 표시합니다.</p>}
          <div className={styles.tableScroll} role="region" aria-label="Root 설치 목록" tabIndex={0}>
            <table className={styles.table} aria-label="Root 설치">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">사용자</th>
                  <th scope="col">Root 패키지</th>
                  <th scope="col">포함된 버전</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              <tbody>
                {trace.installs.map((install, index) => {
                  const selected = install.rootRequestId === search.root
                  const rootHref = logsHref({ ...search, root: install.rootRequestId })
                  return (
                    <tr
                      key={`${install.rootRequestId}@${install.matchedVersion}#${index}`}
                      className={selected ? `${styles.clickableRow} ${styles.selected}` : styles.clickableRow}
                      onClick={(event) => openRoot(event, rootHref)}
                    >
                      <td className={styles.mono}>{formatDateTime(install.occurredAt ?? install.capturedAt)}</td>
                      {/* 이력은 인증된 요청에만 생기므로, 설치 기록 행이 없으면(저장 실패 등) "로그인 안 함"이 아니라 알 수 없는 상태입니다. */}
                      <td>
                        {install.outcome === null
                          ? <span className={styles.muted}>기록 없음</span>
                          : install.username ?? <span className={styles.muted}>로그인 안 함</span>}
                      </td>
                      <td>
                        <Link
                          className={styles.rootLink}
                          href={rootHref}
                          scroll={false}
                          aria-current={selected ? 'true' : undefined}
                        >
                          <span className={styles.packageName}>{install.rootPackageName}</span>
                          <span className={styles.version}>@{install.rootPackageVersion}</span>
                        </Link>
                      </td>
                      <td className={styles.mono}>{install.matchedVersion}</td>
                      {install.outcome ? (
                        <td className={outcomeClass(install.outcome, install.decision)}>{outcomeLabel(install.outcome, install.decision)}</td>
                      ) : (
                        <td><span className={styles.muted}>기록 없음</span></td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      ))}

      {rootDetail && ('error' in rootDetail ? (
        <p className={styles.empty} role="alert">Root 설치의 전체 의존성을 불러오지 못했습니다. ({rootDetail.error})</p>
      ) : (
        <section aria-labelledby="root-title">
          <h3 className={styles.subHeading} id="root-title">Root 설치의 전체 의존성</h3>
          <p className={styles.hint}>{rootDetail.rootPackageName}@{rootDetail.rootPackageVersion} · {rootDetail.dependencies.length}개</p>
          <div className={styles.tableScroll} role="region" aria-label="전체 의존성 목록" tabIndex={0}>
            <table className={`${styles.table} ${styles.depTable}`} aria-label="Root 설치의 전체 의존성">
              <thead>
                <tr>
                  <th scope="col">패키지</th>
                  <th scope="col">integrity</th>
                  <th scope="col">판정</th>
                </tr>
              </thead>
              <tbody>
                {rootDetail.dependencies.map((dependency) => (
                  <tr key={`${dependency.packageName}@${dependency.version}#${dependency.integrity}`}>
                    <td>
                      <span className={styles.packageName}>{dependency.packageName}</span>
                      <span className={styles.version}>@{dependency.version}</span>
                    </td>
                    <td className={styles.mono}>
                      <span className={styles.integrity} title={dependency.integrity}>{dependency.integrity}</span>
                    </td>
                    <td>
                      {/* features끼리는 import하지 않으므로 Package 화면 주소를 직접 만듭니다. */}
                      <Link
                        className={styles.rootLink}
                        href={`/packages?${new URLSearchParams({ q: dependency.packageName })}`}
                        aria-label={`${dependency.packageName} 판정을 Package에서 보기`}
                      >
                        Package에서 보기
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </section>
  )
}
