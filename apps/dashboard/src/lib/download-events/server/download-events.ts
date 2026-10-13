import { getPool, type Queryable } from '@/lib/db'

import { type DownloadEvent, LOG_PAGE_SIZE, type RootDependency, type RootInstall, type RootRequest, type RootRequestQuery } from '../types'

// user_db.download_events 읽기입니다. 서버에서만 import합니다.

/** to는 종료일 다음 날 한국 시간 0시(미포함)입니다. */
export type DownloadEventQuery = { from: Date; to: Date; q: string; user: string }
export { LOG_PAGE_SIZE }

type EventRow = {
  id: string
  occurred_at: Date
  request_id: string
  user_id: string | null
  username: string | null
  source_ip: string | null
  package_name: string
  version: string
  outcome: DownloadEvent['outcome']
  decision: DownloadEvent['decision']
  http_status: number | null
}

/**
 * 루트 여부와 관계없이 모든 tarball 요청을 최신순으로 한 페이지(50건) 읽습니다. 명세 4.3
 * page는 1부터입니다. 전체 건수는 세지 않고, 한 건 더(51행) 읽어 다음 페이지가 있는지만 판단합니다.
 */
export async function listDownloadEvents({ from, to, q, user, page }: DownloadEventQuery & { page: number }, db: Queryable = getPool()):
  Promise<{ events: DownloadEvent[]; hasNext: boolean }> {
  // 주소 값은 readLogSearch가 검증하지만, 음수 OFFSET은 DB 오류가 되므로 직접 호출에도 방어합니다.
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`invalid page: ${page}`)
  const { rows } = await db.query<EventRow>(`
    SELECT id, occurred_at, request_id, user_id, username, host(source_ip) AS source_ip,
           package_name, version, outcome, decision, http_status
    FROM download_events
    WHERE occurred_at >= $1 AND occurred_at < $2
      AND ($3 = '' OR position(lower($3) in lower(package_name || '@' || version)) > 0)
      AND ($4 = '' OR ($4 = '__anonymous__' AND username IS NULL) OR username = $4)
    ORDER BY occurred_at DESC, id
    LIMIT ${LOG_PAGE_SIZE + 1} OFFSET $5
  `, [from, to, q, user, (page - 1) * LOG_PAGE_SIZE])
  return {
    events: rows.slice(0, LOG_PAGE_SIZE).map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      requestId: row.request_id,
      userId: row.user_id,
      username: row.username,
      sourceIp: row.source_ip,
      packageName: row.package_name,
      version: row.version,
      outcome: row.outcome,
      decision: row.decision,
      httpStatus: row.http_status,
    })),
    hasNext: rows.length > LOG_PAGE_SIZE,
  }
}

/** 검색어·선택 사용자와 관계없이 같은 기간에 기록된 사용자 목록입니다. */
export async function listDownloadUsernames({ from, to }: { from: Date; to: Date }, db: Queryable = getPool()): Promise<string[]> {
  const { rows } = await db.query<{ username: string }>(`
    SELECT DISTINCT username FROM download_events
    WHERE occurred_at >= $1 AND occurred_at < $2 AND username IS NOT NULL
    ORDER BY username
  `, [from, to])
  return rows.map((row) => row.username)
}

export const ROOT_TRACE_LIMIT = 200

type RootInstallRow = {
  root_request_id: string
  root_package_name: string
  root_package_version: string
  matched_version: string
  captured_at: Date
  username: string | null
  user_id: string | null
  occurred_at: Date | null
  outcome: RootInstall['outcome']
  decision: RootInstall['decision']
}

/** 패키지(이름은 대소문자 무시·정확 일치, version이 빈 값이면 모든 버전)가 포함된 Root 설치, 최신순. 명세 4.4 */
export async function listRootInstallsContaining(
  { packageName, version }: { packageName: string; version: string }, db: Queryable = getPool(),
): Promise<{ installs: RootInstall[]; truncated: boolean }> {
  // download_events는 LEFT JOIN입니다. 설치 기록 저장이 실패한 설치도 이력에는 남아 있습니다.
  const { rows } = await db.query<RootInstallRow>(`
    SELECT h.root_request_id, h.root_package_name, h.root_package_version,
           h.package_version AS matched_version, h.captured_at,
           e.username, e.user_id, e.occurred_at, e.outcome, e.decision
    FROM install_dependency_history h
    LEFT JOIN download_events e ON e.request_id = h.root_request_id
    WHERE lower(h.package_name) = lower($1)
      AND ($2 = '' OR h.package_version = $2)
    ORDER BY h.captured_at DESC, h.root_request_id, h.package_version
    LIMIT 201
  `, [packageName, version])
  return {
    installs: rows.slice(0, ROOT_TRACE_LIMIT).map((row) => ({
      rootRequestId: row.root_request_id,
      rootPackageName: row.root_package_name,
      rootPackageVersion: row.root_package_version,
      matchedVersion: row.matched_version,
      username: row.username,
      userId: row.user_id,
      occurredAt: row.occurred_at?.toISOString() ?? null,
      capturedAt: row.captured_at.toISOString(),
      outcome: row.outcome,
      decision: row.decision,
    })),
    truncated: rows.length > ROOT_TRACE_LIMIT,
  }
}

/** 한 Root 설치에 포함된 전체 의존성. 그 설치의 이력이 없으면 null입니다. 명세 4.5 */
export async function listRootDependencies(rootRequestId: string, db: Queryable = getPool()):
  Promise<{ rootPackageName: string; rootPackageVersion: string; dependencies: RootDependency[] } | null> {
  const { rows } = await db.query<{
    root_package_name: string; root_package_version: string; package_name: string; package_version: string; integrity: string
  }>(`
    SELECT root_package_name, root_package_version, package_name, package_version, integrity
    FROM install_dependency_history
    WHERE root_request_id = $1
    ORDER BY package_name, package_version
  `, [rootRequestId])
  if (rows.length === 0) return null
  return {
    rootPackageName: rows[0].root_package_name,
    rootPackageVersion: rows[0].root_package_version,
    dependencies: rows.map((row) => ({ packageName: row.package_name, version: row.package_version, integrity: row.integrity })),
  }
}

/** 루트 패키지 요청(is_root = true), 최신순. 명세 4.1 */
export async function listRootRequests({ from, to, q, decision }: RootRequestQuery, db: Queryable = getPool()): Promise<RootRequest[]> {
  const { rows } = await db.query<{
    request_id: string; occurred_at: Date; username: string | null; package_name: string; version: string
    outcome: RootRequest['outcome']; decision: RootRequest['decision']; decision_id: string | null
  }>(`
    SELECT request_id, occurred_at, username, package_name, version, outcome, decision, decision_id
    FROM download_events
    WHERE is_root
      AND occurred_at >= $1 AND occurred_at <= $2
      AND ($3 = '' OR position(lower($3) in lower(package_name)) > 0
                   OR position(lower($3) in lower(coalesce(username, ''))) > 0)
      AND ($4::text IS NULL OR decision = $4)
    ORDER BY occurred_at DESC, id
  `, [from, to, q, decision === 'ALL' ? null : decision])
  return rows.map((row) => ({
    requestId: row.request_id,
    occurredAt: row.occurred_at.toISOString(),
    username: row.username,
    packageName: row.package_name,
    version: row.version,
    outcome: row.outcome,
    decision: row.decision,
    decisionId: row.decision_id,
  }))
}

/** 요청 id별 사용자(루트 여부와 관계없이). 기록이 없는 요청은 결과에 없고, 인증되지 않은 요청은 null입니다. 명세 4.2 */
export async function findRequesters(requestIds: readonly string[], db: Queryable = getPool()): Promise<Map<string, string | null>> {
  if (requestIds.length === 0) return new Map()
  const { rows } = await db.query<{ request_id: string; username: string | null }>(`
    SELECT request_id, username FROM download_events WHERE request_id = ANY($1)
  `, [requestIds])
  return new Map(rows.map((row) => [row.request_id, row.username]))
}
