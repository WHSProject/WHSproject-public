'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

import { DecisionFilter } from '@/components/decision'
import { SearchField } from '@/components/ui/SearchField'
import { useAddressSearch } from '@/components/ui/SearchField/useAddressSearch'
import type { DecisionFilterValue } from '@/lib/decision/types'
import { formatDateTime } from '@/lib/format'

import { packagesHref } from '../model/query'
import type { PackageDetail as Detail, PackageListPage, PackageSearch } from '../types/packages'
import { decisionStyles, PackageDetail } from './PackageDetail'
import styles from './PackagesPage.module.css'

export type PackagesPageProps = {
  search: PackageSearch
  list: PackageListPage
  detail: Detail | null
  error?: string | null
  /** 정책 버전을 Version 페이지로 연결할지(policy:draft) */
  canViewPolicy: boolean
}

// 검색·판정 필터·페이지·선택은 주소 값이고, 서버가 그 값으로 조회해 다시 그립니다.
export function PackagesPage({ search, list, detail, error, canViewPolicy }: PackagesPageProps) {
  const router = useRouter()
  const { query, change, take } = useAddressSearch(search.q, (q) =>
    router.replace(packagesHref({ q, decision: search.decision, page: 1 }), { scroll: false }))

  function handleFilter(decision: DecisionFilterValue) {
    router.push(packagesHref({ q: take(), decision, page: 1 }), { scroll: false })
  }

  const pageHref = (page: number) => packagesHref({ q: search.q, decision: search.decision, page })

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}><h1>Package</h1><p>패키지별 판정과 분석 근거를 확인합니다.</p></div>
      <section className={styles.searchBar}>
        <SearchField value={query} onChange={change} placeholder="패키지 이름 또는 버전으로 검색" />
        <DecisionFilter value={search.decision} onChange={handleFilter} />
      </section>
      {error ? <p role="alert" className={styles.empty}>판정 또는 근거 데이터를 불러오지 못했습니다. DB 연결을 확인해 주세요. ({error})</p> : null}

      <div className={styles.columns}>
        <section className={`${styles.panel} ${styles.listPanel}`} aria-labelledby="package-list-title">
          <div className={styles.listHeading}>
            <h2 id="package-list-title">패키지 {list.total.toLocaleString()}</h2>
            <span>최신 판정순</span>
          </div>
          {list.items.length === 0 ? (
            <p className={styles.empty}>조건에 맞는 패키지가 없습니다.</p>
          ) : (
            <ul className={styles.list} aria-label="패키지 목록">
              {list.items.map((item) => (
                <li key={item.decisionId}>
                  <Link
                    href={packagesHref({ ...search, page: list.page, selected: item.decisionId })}
                    scroll={false}
                    className={`${styles.listItem} ${item.decisionId === search.selected ? styles.listItemActive : ''}`}
                    aria-current={item.decisionId === search.selected ? 'true' : undefined}
                  >
                    <span className={`${styles.dot} ${decisionStyles[item.decision]}`} aria-hidden="true" />
                    <span className={styles.itemName}>{item.packageName}<span>{item.version}</span></span>
                    <span className={styles.itemTime}>{formatDateTime(item.evaluatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <nav className={styles.pager} aria-label="패키지 페이지">
            {list.page > 1
              ? <Link href={pageHref(list.page - 1)} scroll={false} aria-label="이전 페이지">‹</Link>
              : <span aria-disabled="true" aria-label="이전 페이지">‹</span>}
            <span>{list.page} / {list.pageCount}</span>
            {list.page < list.pageCount
              ? <Link href={pageHref(list.page + 1)} scroll={false} aria-label="다음 페이지">›</Link>
              : <span aria-disabled="true" aria-label="다음 페이지">›</span>}
          </nav>
        </section>

        <section className={`${styles.panel} ${styles.detailPanel}`} aria-label="패키지 상세">
          {detail ? (
            <PackageDetail detail={detail} search={search} canViewPolicy={canViewPolicy} />
          ) : (
            <p className={styles.empty}>
              {search.selected ? '선택한 판정을 찾을 수 없습니다. 목록에서 다시 선택하세요.' : '목록에서 패키지를 선택하면 판정 상세가 보입니다.'}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
