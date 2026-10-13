'use client'

import { useSyncExternalStore } from 'react'

import styles from './ThemeToggle.module.css'

const STORAGE_KEY = 'argus-theme'

function subscribe(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  function synchronize() {
    let stored: string | null = null
    try { stored = localStorage.getItem(STORAGE_KEY) } catch { /* 저장이 막혀도 테마를 바꿀 수 있습니다. */ }
    document.documentElement.dataset.theme = stored === 'light' || stored === 'dark'
      ? stored : media.matches ? 'dark' : 'light'
    onChange()
  }
  window.addEventListener('argus-theme-change', onChange)
  window.addEventListener('storage', synchronize)
  media.addEventListener('change', synchronize)
  return () => {
    window.removeEventListener('argus-theme-change', onChange)
    window.removeEventListener('storage', synchronize)
    media.removeEventListener('change', synchronize)
  }
}

export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe,
    () => document.documentElement.dataset.theme === 'dark', () => false)
  const label = dark ? '현재 다크 모드. 라이트 모드로 전환' : '현재 라이트 모드. 다크 모드로 전환'

  function toggle() {
    const next = dark ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    try { localStorage.setItem(STORAGE_KEY, next) } catch { /* 현재 페이지에는 즉시 반영합니다. */ }
    window.dispatchEvent(new Event('argus-theme-change'))
  }

  return (
    <button type="button" role="switch" aria-checked={dark} aria-label={label} title={label}
      className={styles.toggle} onClick={toggle}>
      <svg className={styles.day} viewBox="0 0 92 40" aria-hidden="true">
        <path d="M51 40V31a8 8 0 0 1 11-7 10 10 0 0 1 20-3 8 8 0 0 1 12 7v12Z" fill="var(--theme-cloud)" />
        <path d="M62 40V33a8 8 0 0 1 11-7 9 9 0 0 1 17 5 7 7 0 0 1 9 9Z" fill="var(--theme-cloud-front)" />
      </svg>
      <svg className={styles.night} viewBox="0 0 92 40" aria-hidden="true" fill="var(--theme-cloud-front)">
        <path d="m17 10 1.2 3.8L22 15l-3.8 1.2L17 20l-1.2-3.8L12 15l3.8-1.2ZM40 21l.8 2.2L43 24l-2.2.8L40 27l-.8-2.2L37 24l2.2-.8Z" />
        <circle cx="30" cy="9" r="1" /><circle cx="28" cy="29" r="1" /><circle cx="48" cy="11" r="1" /><circle cx="11" cy="29" r=".8" />
      </svg>
      <span className={styles.thumb} aria-hidden="true">
        <svg className={styles.sun} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </svg>
        <svg className={styles.moon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
        </svg>
      </span>
    </button>
  )
}
