import type { DownloadEvent, RootDependency, RootInstall } from '@/lib/download-events/types'

/** 화면에 보이는 탭입니다. events는 설치 기록, trace는 의존성 역추적입니다. */
export type LogView = 'events' | 'trace'

/**
 * view는 보이는 탭, page는 설치 기록 탭의 페이지(1부터)입니다.
 * trace·traceVersion은 의존성 역추적할 패키지, root는 의존성 목록을 볼 Root 설치의 request id입니다. 역추적에는 기간을 적용하지 않습니다.
 */
export type LogSearch = {
  q: string; user: string; from: string; to: string
  trace: string; traceVersion: string; root: string
  view: LogView; page: number
}

/** 설치 기록 한 페이지. 전체 건수는 세지 않고, 다음 페이지가 있는지만 압니다. */
type LogEvents = { events: DownloadEvent[]; usernames: string[]; hasNext: boolean } | { error: string }

/** 역추적 결과. 조회가 실패하면 error만 담으며, 같은 화면의 다른 조회에는 영향을 주지 않습니다. */
export type LogTrace = { installs: RootInstall[]; truncated: boolean } | { error: string }

export type LogRootDetail =
  | { rootRequestId: string; rootPackageName: string; rootPackageVersion: string; dependencies: RootDependency[] }
  | { error: string }

/** 보이는 탭의 데이터만 조회하므로, 다른 탭의 항목과 주소에 trace·root가 없는 항목은 null입니다. */
export type LogsPageData = { log: LogEvents | null; trace: LogTrace | null; rootDetail: LogRootDetail | null }
