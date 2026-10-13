import { unavailableMessage } from '@/lib/policy/common/errors'

import styles from './VersionsPage.module.css'

// 정책을 불러오지 못했을 때의 화면입니다. code가 없으면 적용 중인 정책이 없는 경우입니다.
export function VersionsMessage({ code }: { code?: string }) {
  if (!code) return <p className={styles.message}>적용 중인 npm 정책이 없습니다. Policy DB에 초기 정책을 먼저 등록해야 합니다.</p>
  return <p className={styles.message} role="alert">{unavailableMessage(code)}</p>
}
