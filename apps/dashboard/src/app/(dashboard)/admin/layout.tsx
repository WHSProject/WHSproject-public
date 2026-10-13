import type { ReactNode } from 'react'

import { AdminLayout } from '@/features/admin'

// Admin 탭만 그립니다. 레이아웃은 화면 이동 때 다시 실행되지 않으므로 권한 확인은 각 page.tsx가 합니다.
export default function Layout({ children }: { children: ReactNode }) {
  return <AdminLayout>{children}</AdminLayout>
}
