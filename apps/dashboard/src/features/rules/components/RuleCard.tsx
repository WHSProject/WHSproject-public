'use client'

import { type Decision, DECISIONS } from '@/lib/decision/types'

import { categoryLabel, MINIMUM_SUPPORT_LABELS, ON_UNKNOWN_LABELS, predicateLabel } from '@/lib/policy/common/labels'
import type { MinimumSupport, OnUnknown, Predicate, Rule } from '@/lib/policy/common/types'

import { groupByCategory, PRIORITY_MAX, PRIORITY_MIN } from '../model/rules'
import styles from './RulesPage.module.css'

const DECISION_CLASS: Record<Decision, string> = {
  ACCEPT: styles.accept,
  REJECT: styles.reject,
  HOLD: styles.hold,
  REVIEW: styles.review,
}

type RuleCardProps = {
  rule: Rule
  predicates: readonly Predicate[]
  issues: readonly string[]
  onChange: (rule: Rule) => void
  onRemove: () => void
}

// 접근성 이름은 이름이 비어 있어도 구분되도록 식별 코드를 씁니다.
export function RuleCard({ rule, predicates, issues, onChange, onRemove }: RuleCardProps) {
  const label = rule.ruleCode
  const available = predicates.filter((predicate) => !rule.conditions.includes(predicate.code))
  const update = (patch: Partial<Rule>) => onChange({ ...rule, ...patch })

  return (
    <article className={`${styles.rule} ${DECISION_CLASS[rule.decision]} ${rule.enabled ? '' : styles.disabledRule}`} aria-label={`Rule ${label}`}>
      <div className={styles.ruleHead}>
        <div className={styles.decisions} role="group" aria-label={`${label} 판정`}>
          {DECISIONS.map((decision) => (
            <button
              key={decision}
              type="button"
              className={`${styles.decisionButton} ${DECISION_CLASS[decision]}`}
              aria-pressed={rule.decision === decision}
              onClick={() => update({ decision })}
            >
              {decision}
            </button>
          ))}
        </div>
        <label className={styles.inlineField}>
          우선순위
          <input
            className={styles.priority}
            type="number"
            min={PRIORITY_MIN}
            max={PRIORITY_MAX}
            step={1}
            aria-label={`${label} 우선순위`}
            value={Number.isFinite(rule.priority) ? rule.priority : ''}
            onChange={(event) => update({ priority: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
          />
        </label>
        <label className={styles.inlineField}>
          <input type="checkbox" checked={rule.enabled} aria-label={`${label} 활성`} onChange={(event) => update({ enabled: event.target.checked })} />
          활성
        </label>
        <button type="button" className={styles.removeRule} aria-label={`${label} 삭제`} onClick={onRemove}>
          삭제
        </button>
      </div>

      <div className={styles.ruleIdentity}>
        <input
          className={styles.ruleName}
          aria-label={`${label} 이름`}
          placeholder="Rule 이름 (예: Credential 유출 차단)"
          value={rule.name}
          onChange={(event) => update({ name: event.target.value })}
        />
        <span className={styles.ruleCode}>{rule.ruleCode}</span>
      </div>

      <div className={styles.conditionBox}>
        <select
          className={styles.select}
          aria-label={`${label} 조건 방식`}
          value={rule.matchAll ? 'all' : 'any'}
          onChange={(event) => update({ matchAll: event.target.value === 'all' })}
        >
          <option value="all">모든 조건(AND)</option>
          <option value="any">하나 이상(OR)</option>
        </select>
        {rule.conditions.map((code) => (
          <span key={code} className={styles.predicate} title={`${code} — ${predicates.find((item) => item.code === code)?.description ?? ''}`}>
            {predicateLabel(code)}
            <button type="button" aria-label={`${label} 조건 ${predicateLabel(code)} 삭제`} onClick={() => update({ conditions: rule.conditions.filter((item) => item !== code) })}>
              ×
            </button>
          </span>
        ))}
        {available.length > 0 ? (
          <select
            className={`${styles.select} ${styles.addSelect}`}
            aria-label={`${label} 조건 추가`}
            value=""
            onChange={(event) => event.target.value && update({ conditions: [...rule.conditions, event.target.value] })}
          >
            <option value="">+ 조건 추가</option>
            {groupByCategory(available).map(([category, items]) => (
              <optgroup key={category} label={categoryLabel(category)}>
                {items.map((item) => (
                  <option key={item.code} value={item.code}>{predicateLabel(item.code)}</option>
                ))}
              </optgroup>
            ))}
          </select>
        ) : null}
      </div>

      <details className={styles.advanced}>
        <summary>고급 설정</summary>
        <div className={styles.advancedFields}>
          <label className={styles.inlineField}>
            분석 범위
            <select
              className={styles.select}
              aria-label={`${label} 분석 범위`}
              value={rule.minimumSupport}
              onChange={(event) => update({ minimumSupport: event.target.value as MinimumSupport })}
            >
              {(Object.keys(MINIMUM_SUPPORT_LABELS) as MinimumSupport[]).map((key) => (
                <option key={key} value={key}>{MINIMUM_SUPPORT_LABELS[key]}</option>
              ))}
            </select>
          </label>
          <label className={styles.inlineField}>
            판단할 수 없을 때
            <select
              className={styles.select}
              aria-label={`${label} 판단할 수 없을 때`}
              value={rule.onUnknown}
              onChange={(event) => update({ onUnknown: event.target.value as OnUnknown })}
            >
              {(Object.keys(ON_UNKNOWN_LABELS) as OnUnknown[]).map((key) => (
                <option key={key} value={key}>{ON_UNKNOWN_LABELS[key]}</option>
              ))}
            </select>
          </label>
        </div>
      </details>

      {issues.length > 0 ? (
        <ul className={styles.issues} aria-label={`${label} 검사 결과`}>
          {issues.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}
