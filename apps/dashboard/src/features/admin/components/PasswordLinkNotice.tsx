'use client'

import { useRef, useState } from 'react'

import { formatDateTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { FormNotice } from '@/components/ui/FormNotice'

import type { PasswordLink } from '../types/users'
import styles from './AdminPage.module.css'

// 발급한 링크를 Admin이 복사해 전달합니다. 다시 보여 주지 않으므로 잃어버리면 새로 발급합니다.
// http 사내망에서는 브라우저가 클립보드 API를 막으므로, 실패하면 링크를 선택해 직접 복사하게 합니다.
export function PasswordLinkNotice({ message, link }: { message: string; link: PasswordLink }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopy('copied')
    } catch {
      inputRef.current?.select()
      setCopy('failed')
    }
  }

  return (
    <FormNotice tone="success">
      <p className={styles.linkMessage}>{message}</p>
      <div className={styles.linkRow}>
        <input
          ref={inputRef}
          className={styles.linkInput}
          aria-label="비밀번호 설정 링크"
          readOnly
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button variant="ghost" className={styles.smallButton} onClick={() => void copyLink()}>
          {copy === 'copied' ? '복사됨' : '복사'}
        </Button>
      </div>
      <p className={styles.hint}>
        {formatDateTime(link.expiresAt)}까지 한 번 쓸 수 있습니다.
        {copy === 'failed' ? ' 자동으로 복사하지 못했습니다. 선택된 링크를 직접 복사하세요.' : null}
      </p>
    </FormNotice>
  )
}
