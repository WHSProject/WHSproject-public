import Link from 'next/link'

import styles from './ForbiddenPage.module.css'

// 로그인은 했지만 권한이 없는 화면에 들어왔을 때(403) 보여 줍니다.
export function ForbiddenPage() {
  return (
    <section className={styles.forbidden}>
      <div className={styles.code} aria-hidden="true">403</div>
      <p>ACCESS DENIED · 403</p>
      <h1>이 화면을 볼 권한이 없습니다.</h1>
      <span>필요한 권한이 있는 계정으로 로그인하거나 Admin에게 권한을 요청하세요.</span>
      <Link href="/">Overview로 돌아가기</Link>
    </section>
  )
}
