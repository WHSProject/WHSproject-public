import { ForbiddenPage } from '../_shell/status'

// requirePermission()이 forbidden()을 호출하면 AppShell 안에 이 화면을 그리고 403으로 응답합니다.
export default function Forbidden() {
  return <ForbiddenPage />
}
