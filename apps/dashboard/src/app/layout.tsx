import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'

import './_shell/styles/global.css'
import './_shell/styles/tokens.css'

export const metadata: Metadata = {
  title: 'ARGUS Security Dashboard',
  description: 'ARGUS 공급망 보안 운영 대시보드',
}

export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f4f6f9' }, { media: '(prefers-color-scheme: dark)', color: '#0b1019' }],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: `try{const t=localStorage.getItem('argus-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}` }} /></head>
      <body>{children}</body>
    </html>
  )
}
