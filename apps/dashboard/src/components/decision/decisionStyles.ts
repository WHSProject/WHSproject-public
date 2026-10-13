import type { Decision } from '@/lib/decision/types'
import styles from './decision.module.css'

export const decisionStyles: Record<Decision, string> = {
  ACCEPT: styles.accept,
  REJECT: styles.reject,
  HOLD: styles.hold,
  REVIEW: styles.review,
}
