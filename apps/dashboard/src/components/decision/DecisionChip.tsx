import type { Decision } from '@/lib/decision/types'
import { decisionStyles } from './decisionStyles'
import styles from './decision.module.css'

export function DecisionChip({ decision }: { decision: Decision }) {
  return <span className={`${styles.chip} ${decisionStyles[decision]}`}><span aria-hidden="true" />{decision}</span>
}
