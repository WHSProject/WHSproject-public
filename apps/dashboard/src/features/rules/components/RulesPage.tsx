'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'
import type { PolicyVersion, Predicate, Rule } from '@/lib/policy/common/types'

import { applyRulesRequest } from '../api/rules'
import { filterRules, newRule, NO_FILTER, PRIORITY_MAX, PRIORITY_MIN, type RuleFilter, type RuleIssue, validateRules } from '../model/rules'
import { ConditionFilter } from './ConditionFilter'
import { RuleCard } from './RuleCard'
import styles from './RulesPage.module.css'
import { useLeaveGuard } from './useLeaveGuard'

export type RulesPageProps = {
  policy: PolicyVersion
  predicates: Predicate[]
  /** Present only for older callers while the predicate registry migration rolls out. */
  predicateSource?: 'policy' | 'fallback'
  canApply: boolean
}

const LEAVE_MESSAGE = '적용하지 않은 변경이 사라집니다. 이 페이지를 벗어날까요?'

// React key는 식별 코드와 별개로 둡니다. 편집 중 화면이 뒤섞이지 않도록 정렬은 처음 불러올 때만 합니다.
type EditingRule = { key: number; rule: Rule }
let nextKey = 0
// 판정 엔진처럼 우선순위가 큰 Rule부터 보여 줍니다.
const toEditing = (rules: readonly Rule[]): EditingRule[] =>
  [...rules].sort((a, b) => b.priority - a.priority).map((rule) => ({ key: nextKey++, rule }))

// 편집 내용은 브라우저에만 있고, "적용"하면 새 버전으로 만들어 바로 활성화합니다.
// 적용이 끝나면 page.tsx가 새 버전을 key로 이 화면을 다시 만들므로 편집 상태도 초기화됩니다.
export function RulesPage({ policy, predicates, predicateSource, canApply }: RulesPageProps) {
  const router = useRouter()
  const [initial] = useState(() => toEditing(policy.rules))
  const [rules, setRules] = useState(initial)
  const [filter, setFilter] = useState<RuleFilter>(NO_FILTER)
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverIssues, setServerIssues] = useState<RuleIssue[]>([])

  const current = rules.map((item) => item.rule)
  const dirty = JSON.stringify(current) !== JSON.stringify(initial.map((item) => item.rule))
  const issues = [...validateRules(current, predicates), ...serverIssues]
  const visible = filterRules(rules, filter)
  const canSubmit = canApply && dirty && issues.length === 0 && !pending

  useLeaveGuard(dirty, LEAVE_MESSAGE)

  function edit(next: EditingRule[]) {
    setRules(next)
    setServerIssues([])
    setError(null)
  }

  function addRule() {
    // 새 Rule이 필터에 가려지지 않도록 필터를 풉니다.
    setFilter(NO_FILTER)
    edit([...rules, { key: nextKey++, rule: newRule(current) }])
  }

  async function apply() {
    // 확인창이 열린 뒤 변경을 취소하거나 오류가 생겼으면 보내지 않습니다.
    if (!canSubmit) return
    setPending(true)
    setError(null)
    const result = await applyRulesRequest(policy.policyKey, policy.version, current)
    setPending(false)
    setConfirming(false)
    if (!result.ok) {
      setServerIssues(result.issues)
      setError(result.message)
      return
    }
    router.refresh()
  }

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}><h1>Rule</h1><p>패키지 보안 판정에 사용할 조건과 우선순위를 관리합니다.</p></div>
      <section className={styles.panel} aria-labelledby="rules-title">
        <div className={styles.header}>
          <div>
            <p className={styles.eyebrow}>POLICY · RULES · v{policy.version}</p>
            <h2 id="rules-title" className={styles.title}>
              {policy.name}
              <span className={styles.status}>적용 중</span>
            </h2>
            <p className={styles.description}>
              Policy가 제공하는 조건을 조합해 <span className={styles.accept}>ACCEPT</span>·<span className={styles.reject}>REJECT</span>·<span className={styles.hold}>HOLD</span>·<span className={styles.review}>REVIEW</span>를 정합니다.<br/>
              우선순위({PRIORITY_MIN}~{PRIORITY_MAX})가 큰 Rule부터 평가하며, 어떤 Rule에도 해당하지 않으면 <span className={styles.review}>REVIEW</span>입니다.
            </p>
            {predicateSource === 'fallback' ? (
              <p className={styles.note}>Policy에서 조건 목록을 받지 못해 기본 조건 목록을 사용합니다.</p>
            ) : null}
          </div>
          {canApply ? (
            <div className={styles.actions}>
              {dirty ? <span className={styles.dirty}>적용하지 않은 변경 있음</span> : null}
              <Button variant="ghost" onClick={() => edit(initial)} disabled={!dirty || pending}>변경 취소</Button>
              <Button onClick={() => setConfirming(true)} disabled={!canSubmit}>적용</Button>
            </div>
          ) : null}
        </div>

        {confirming ? (
          <div className={styles.confirm} role="alertdialog" aria-label="적용 확인">
            <p>
              새 버전으로 만들어 바로 판정에 사용하고, 지금 버전 v{policy.version}은 보관합니다.
              <br />
              이미 판정된 패키지에는 적용되지 않습니다(기존 판정 재사용).
            </p>
            <Button onClick={() => void apply()} disabled={!canSubmit}>{pending ? '적용 중…' : '적용 확인'}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>돌아가기</Button>
          </div>
        ) : null}
        {error ? <FormNotice tone="error">{error}</FormNotice> : null}
      </section>

      <section className={styles.panel} aria-labelledby="builder-title">
        <div className={styles.builderHead}>
          <div>
            <h2 id="builder-title" className={styles.panelHeading}>Rule 목록</h2>
            <p className={styles.panelCaption}>Rule {current.length}개 · 오류 {issues.length}</p>
          </div>
          <Button variant="ghost" onClick={addRule}>+ Rule 추가</Button>
        </div>
        <ConditionFilter predicates={predicates} rules={current} filter={filter} onChange={setFilter} />

        <div className={styles.rules}>
          {visible.map(({ key, rule }) => (
            <RuleCard
              key={key}
              rule={rule}
              predicates={predicates}
              issues={[...new Set(issues.filter((issue) => issue.ruleCode === rule.ruleCode).map((issue) => issue.message))]}
              onChange={(next) => edit(rules.map((item) => (item.key === key ? { key, rule: next } : item)))}
              onRemove={() => edit(rules.filter((item) => item.key !== key))}
            />
          ))}
          {rules.length === 0 ? <p className={styles.muted}>Rule이 없습니다. 어떤 패키지든 <span className={styles.review}>REVIEW</span>로 판정됩니다.</p> : null}
          {rules.length > 0 && visible.length === 0 ? <p className={styles.muted}>조건에 맞는 Rule이 없습니다.</p> : null}
        </div>
      </section>
    </div>
  )
}
