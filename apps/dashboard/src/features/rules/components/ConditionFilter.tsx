'use client'

import { DecisionFilter } from '@/components/decision'
import { categoryLabel, predicateLabel } from '@/lib/policy/common/labels'
import type { Predicate, Rule } from '@/lib/policy/common/types'

import { groupByCategory, type RuleFilter } from '../model/rules'
import styles from './RulesPage.module.css'

type ConditionFilterProps = {
  predicates: readonly Predicate[]
  rules: readonly Rule[]
  filter: RuleFilter
  onChange: (filter: RuleFilter) => void
}

// 접었다 펼 수 있는 필터입니다. 등록된 조건을 분류별로 보여 주고, 고른 조건이 들어 있는 Rule만 남깁니다.
// 숫자는 그 조건을 쓰는 Rule 수입니다. 접혀 있어도 머리말에 지금 걸린 필터를 보여 줍니다.
export function ConditionFilter({ predicates, rules, filter, onChange }: ConditionFilterProps) {
  const { decision, conditions, matchAll } = filter
  const toggle = (code: string) =>
    onChange({ ...filter, conditions: conditions.includes(code) ? conditions.filter((item) => item !== code) : [...conditions, code] })
  const active = [
    decision === 'ALL' ? null : decision,
    conditions.length > 0 ? `조건 ${conditions.length}개(${matchAll ? 'AND' : 'OR'})` : null,
  ].filter(Boolean)

  return (
    <details className={styles.filterPanel}>
      <summary>
        필터
        <span className={styles.filterSummary}>{active.length > 0 ? active.join(' · ') : '없음'}</span>
      </summary>
      <div className={styles.conditionFilter} role="group" aria-label="조건 필터">
        <div className={styles.conditionFilterHead}>
          <span className={styles.conditionFilterTitle}>조건</span>
          <div className={styles.matchToggle} role="group" aria-label="조건 결합 방식">
            <button type="button" aria-pressed={matchAll} onClick={() => onChange({ ...filter, matchAll: true })}>모두 포함(AND)</button>
            <button type="button" aria-pressed={!matchAll} onClick={() => onChange({ ...filter, matchAll: false })}>하나 이상(OR)</button>
          </div>
          <DecisionFilter value={decision} onChange={(next) => onChange({ ...filter, decision: next })} />
          {conditions.length > 0 ? (
            <button type="button" className={styles.clearFilter} onClick={() => onChange({ ...filter, conditions: [] })}>
              선택 해제({conditions.length})
            </button>
          ) : null}
        </div>
        {groupByCategory(predicates).map(([category, items]) => (
          <div key={category} className={styles.conditionGroup}>
            <span className={styles.conditionCategory}>{categoryLabel(category)}</span>
            <div className={styles.conditionChips}>
              {items.map((predicate) => (
                <button
                  key={predicate.code}
                  type="button"
                  className={styles.conditionChip}
                  aria-pressed={conditions.includes(predicate.code)}
                  title={`${predicate.code} — ${predicate.description}`}
                  onClick={() => toggle(predicate.code)}
                >
                  {predicateLabel(predicate.code)}
                  <span>{rules.filter((rule) => rule.conditions.includes(predicate.code)).length}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>
  )
}
