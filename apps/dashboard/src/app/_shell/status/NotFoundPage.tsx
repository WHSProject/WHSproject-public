import Link from 'next/link'

import styles from './NotFoundPage.module.css'

export function NotFoundPage() {
  return (
    <section className={styles.notFound}>
      <div className={styles.code} aria-hidden="true">404</div>
      <p>ROUTE ERROR · 404</p>
      <h1>요청한 화면을 찾을 수 없습니다.</h1>
      <span>등록되지 않은 Dashboard 경로입니다.</span>
      <Link href="/">Overview로 돌아가기</Link>
    </section>
  )
}
