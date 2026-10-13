import { DecisionChip } from '@/components/decision'
import { MINIMUM_SUPPORT_LABELS, ON_UNKNOWN_LABELS, predicateLabel } from '@/lib/policy/common/labels'
import type { Rule } from '@/lib/policy/common/types'

import styles from './VersionsPage.module.css'

// 한 버전의 Rule을 읽기 전용으로 보여 줍니다. 판정 엔진처럼 우선순위가 큰 Rule부터 보여 줍니다.
export function VersionRules({ rules }: { rules: readonly Rule[] }) {
  if (rules.length === 0) return <p className={styles.muted}>Rule이 없습니다. 어떤 패키지든 REVIEW로 판정됩니다.</p>

  return (
    <div className={styles.tableScroll} role="region" aria-label="버전 Rule 목록" tabIndex={0}>
      <table className={styles.table} aria-label="버전 Rule">
        <thead>
          <tr>
            <th scope="col">우선순위</th>
            <th scope="col">판정</th>
            <th scope="col">이름</th>
            <th scope="col">조건</th>
            <th scope="col">활성</th>
            <th scope="col">고급 설정</th>
          </tr>
        </thead>
        <tbody>
          {[...rules].sort((a, b) => b.priority - a.priority).map((rule) => (
            <tr key={rule.ruleCode} className={rule.enabled ? undefined : styles.disabledRow}>
              <td className={styles.mono}>{rule.priority}</td>
              <td><DecisionChip decision={rule.decision} /></td>
              <td>
                <span className={styles.name}>{rule.name}</span>
                <span className={styles.code}>{rule.ruleCode}</span>
              </td>
              <td>
                <span className={styles.muted}>{rule.matchAll ? '모두(AND)' : '하나 이상(OR)'}</span>
                <span className={styles.conditions}>
                  {rule.conditions.map((code) => (
                    <span key={code} className={styles.condition} title={code}>{predicateLabel(code)}</span>
                  ))}
                </span>
              </td>
              <td className={styles.nowrap}>{rule.enabled ? '사용' : '사용 안 함'}</td>
              <td className={styles.small}>
                {MINIMUM_SUPPORT_LABELS[rule.minimumSupport]}
                <br />
                판단 불가 시 {ON_UNKNOWN_LABELS[rule.onUnknown]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
