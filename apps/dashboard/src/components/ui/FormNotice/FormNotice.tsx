import type { ReactNode } from 'react'

import styles from './FormNotice.module.css'

type FormNoticeProps = {
  tone?: 'info' | 'success' | 'error'
  children: ReactNode
}

// 폼 결과 안내입니다. 오류는 즉시 읽히도록 alert, 나머지는 status로 알립니다.
export function FormNotice({ tone = 'info', children }: FormNoticeProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`${styles.notice} ${styles[tone]}`}>
      {children}
    </div>
  )
}
