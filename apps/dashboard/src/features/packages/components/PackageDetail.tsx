import Link from 'next/link'

import { DecisionChip } from '@/components/decision'
import type { Decision } from '@/lib/decision/types'
import { formatDateTime } from '@/lib/format'
import { predicateLabel } from '@/lib/policy/common/labels'

import { packagesHref } from '../model/query'
import type { PackageDetail as Detail, PackageSearch } from '../types/packages'
import styles from './PackagesPage.module.css'

export const decisionStyles: Record<Decision, string> = {
  ACCEPT: styles.accept,
  REJECT: styles.reject,
  HOLD: styles.hold,
  REVIEW: styles.review,
}

type Props = { detail: Detail; search: PackageSearch; canViewPolicy: boolean }

// 판정 1건의 상세: 사유, 판정한 정책 버전과 그 버전의 매칭 Rule, 근거(Evidence), 같은 패키지의 버전별 판정
export function PackageDetail({ detail, search, canViewPolicy }: Props) {
  return (
    <div className={styles.detail}>
      <div className={styles.detailHeading}>
        <h2>{detail.packageName}</h2>
        <p className={styles.meta}>{detail.version} · 판정 {formatDateTime(detail.evaluatedAt)}</p>
        {/* features끼리는 import하지 않으므로 Logs의 logsHref 대신 주소를 직접 만듭니다. */}
        <p className={styles.traceLink}>
          <Link href={`/logs?${new URLSearchParams({ view: 'trace', trace: detail.packageName, traceVersion: detail.version })}`}>
            이 패키지가 포함된 설치 보기
          </Link>
        </p>
        <DecisionChip decision={detail.decision} />
      </div>

      <section aria-labelledby="reason-title">
        <h3 className={styles.blockHeading} id="reason-title">사유</h3>
        <p className={styles.reason}>{detail.reason}</p>
        <span className={styles.code}>{detail.reasonCode}</span>
      </section>

      <section aria-labelledby="rules-title">
        <div className={styles.blockHead}>
          <h3 className={styles.blockHeading} id="rules-title">매칭 Rule</h3>
          <span className={styles.policyVersion}>
            정책 v{detail.policyVersion}
            {canViewPolicy && detail.policyLinkable ? <Link href={`/versions?view=${encodeURIComponent(detail.policyVersion)}`}>Rule 보기</Link> : null}
          </span>
        </div>
        {detail.policyError ? (
          <p className={styles.note}>판정한 정책 버전을 불러오지 못해 Rule 코드만 보여 줍니다. ({detail.policyError})</p>
        ) : null}
        {detail.matchedRules.length === 0 ? (
          <p className={styles.empty}>매칭된 Rule이 없습니다. 어떤 Rule에도 해당하지 않으면 REVIEW로 판정합니다.</p>
        ) : (
          <ul className={styles.rows}>
            {detail.matchedRules.map(({ ruleCode, rule }) => (
              <li className={styles.ruleRow} key={ruleCode}>
                {rule ? <DecisionChip decision={rule.decision} /> : null}
                <div className={styles.ruleBody}>
                  <span className={styles.ruleName}>{rule ? rule.name : '정책 버전에서 찾지 못한 Rule'}</span>
                  <span className={styles.code}>{ruleCode}</span>
                  {rule ? (
                    <span className={styles.conditions}>
                      <span className={styles.muted}>{rule.matchAll ? '모두(AND)' : '하나 이상(OR)'}</span>
                      {rule.conditions.map((code) => (
                        <span key={code} className={styles.condition} title={code}>{predicateLabel(code)}</span>
                      ))}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="evidence-title">
        <h3 className={styles.blockHeading} id="evidence-title">근거(Evidence)</h3>
        {detail.evidences.length === 0 && detail.missingEvidenceIds.length === 0 ? (
          <p className={styles.empty}>판정에 쓰인 근거가 없습니다.</p>
        ) : (
          <ul className={styles.rows}>
            {detail.evidences.map((evidence) => (
              <li className={styles.evidenceRow} key={evidence.evidenceId}>
                <span className={styles.signalType}>{evidence.signalType}</span>
                <span className={styles.muted}>{evidence.category}</span>
                <span className={styles.summary}>{evidence.summary}</span>
              </li>
            ))}
          </ul>
        )}
        {detail.missingEvidenceIds.length > 0 ? (
          <p className={styles.note}>근거 {detail.missingEvidenceIds.length}건을 찾지 못했습니다. ({detail.missingEvidenceIds.join(', ')})</p>
        ) : null}
      </section>

      <section aria-labelledby="history-title">
        <h3 className={styles.blockHeading} id="history-title">버전 이력</h3>
        <ul className={styles.rows}>
          {detail.history.map((entry) => (
            <li key={entry.decisionId}>
              <Link
                href={packagesHref({ ...search, selected: entry.decisionId })}
                scroll={false}
                className={`${styles.historyRow} ${entry.version === detail.version ? styles.historyCurrent : ''}`}
                aria-current={entry.version === detail.version ? 'true' : undefined}
              >
                <span className={styles.historyVersion}>{entry.version}</span>
                <span className={styles.historyTime}>{formatDateTime(entry.evaluatedAt)}</span>
                <span className={`${styles.historyDecision} ${decisionStyles[entry.decision]}`}>
                  <span aria-hidden="true" />{entry.decision}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
