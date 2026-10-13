'use client'

import { useEffect, useRef, useState } from 'react'

import styles from './OverviewPage.module.css'

// 카드의 실제 둘레를 기준으로 미승인/전체 비율을 그립니다.
export function PackageRatioCard({ total, notAccepted }: { total: number; notAccepted: number }) {
  const card = useRef<HTMLElement>(null)
  const [size, setSize] = useState({ width: 276, height: 136 })
  useEffect(() => {
    const element = card.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect()
      setSize({ width, height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const percent = total === 0 ? 0 : notAccepted / total * 100
  return (
    <article ref={card} className={`${styles.kpiCard} ${styles.notAccepted}`}>
      <svg className={styles.cardRing} viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
        role="img" aria-label={`판정 ${total}건 중 미승인 ${notAccepted}건`}>
        <rect x="1.5" y="1.5" width={size.width - 3} height={size.height - 3} rx="10" pathLength="100"
          fill="none" stroke={total === 0 ? 'var(--color-border)' : 'var(--decision-accept)'} strokeWidth="3" />
        {notAccepted > 0 ? <rect x="1.5" y="1.5" width={size.width - 3} height={size.height - 3} rx="10" pathLength="100"
          fill="none" stroke="var(--decision-reject)" strokeWidth="3" strokeDasharray={`${percent} ${100 - percent}`} /> : null}
      </svg>
      <h2 className={styles.kpiLabel}>미승인</h2>
      <div className={styles.ratioValue}><strong>{notAccepted}</strong><span>/ {total}</span></div>
      <p className={styles.ratioCaption}>미승인 {notAccepted}건</p>
      <p className={styles.ratioNote}>전체 판정 기준</p>
    </article>
  )
}
