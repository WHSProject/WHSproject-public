import { DECISIONS, type DecisionFilterValue } from '@/lib/decision/types'
import styles from './decision.module.css'

type DecisionFilterProps = {
  value: DecisionFilterValue
  onChange: (value: DecisionFilterValue) => void
}

// 버튼 순서는 '전체' 다음 DECISIONS 순서입니다(모든 페이지 공통).
export function DecisionFilter({ value, onChange }: DecisionFilterProps) {
  const options: { value: DecisionFilterValue; label: string }[] = [
    { value: 'ALL', label: '전체' },
    ...DECISIONS.map((decision) => ({ value: decision, label: decision })),
  ]
  return (
    <div className={styles.segment} role="group" aria-label="판정 필터">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segmentItem} ${value === option.value ? styles.segmentActive : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
