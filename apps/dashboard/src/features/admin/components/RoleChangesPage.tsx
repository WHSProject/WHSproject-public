import { roleLabel } from '@/lib/auth/common/labels'
import type { RoleOption } from '@/lib/auth/common/roles'
import { formatDateTime } from '@/lib/format'

import type { RoleChangeRow } from '../types/role-changes'
import styles from './AdminPage.module.css'

type RoleChangesPageProps = {
  changes: RoleChangeRow[]
  roles: RoleOption[]
  limit: number
}

// 변경한 사람이 기록된 변경은 Admin 페이지에서, 없는 변경은 DB에서 직접 수정한 것입니다.
export function RoleChangesPage({ changes, roles, limit }: RoleChangesPageProps) {
  return (
    <section className={styles.panel} aria-labelledby="role-changes-title">
      <p className={styles.eyebrow}>ADMIN · AUDIT</p>
      <h2 id="role-changes-title" className={styles.sectionTitle}>권한 변경 이력</h2>
      <p className={styles.description}>
        권한이 바뀔 때마다 DB가 자동으로 기록하며, 기록은 수정하거나 지울 수 없습니다. 최근 {limit}건을 보여 줍니다.
      </p>

      <div className={styles.stack}>
        {changes.length === 0 ? (
          <p className={styles.empty}>아직 권한 변경 이력이 없습니다.</p>
        ) : (
          <div className={styles.tableScroll} role="region" aria-label="권한 변경 이력 목록" tabIndex={0}>
            <table className={styles.table} aria-label="권한 변경 이력">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">대상</th>
                  <th scope="col">변경</th>
                  <th scope="col">변경한 사람</th>
                  <th scope="col">경로</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((change) => (
                  <tr key={change.id}>
                    <td className={`${styles.mono} ${styles.nowrap}`}>{formatDateTime(change.changedAt)}</td>
                    <td className={styles.name}>{change.target}</td>
                    <td className={styles.nowrap}>
                      {roleLabel(roles, change.previousRole)} → {roleLabel(roles, change.newRole)}
                    </td>
                    <td>{change.changedBy ?? <span className={styles.muted}>-</span>}</td>
                    <td>
                      <span className={`${styles.chip} ${change.changedBy ? styles.chipPositive : styles.chipNeutral}`}>
                        {change.changedBy ? 'Admin 페이지' : 'DB 직접 수정'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
