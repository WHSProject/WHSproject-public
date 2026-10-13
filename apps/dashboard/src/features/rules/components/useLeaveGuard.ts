import { useEffect } from 'react'

// 적용하지 않은 변경이 있으면 페이지를 벗어나기 전에 확인합니다.
// - 창 닫기·새로고침·주소 이동: beforeunload(브라우저 기본 확인창)
// - 사이드바 등 화면 안 링크: Next.js App Router에는 이동을 막는 기능이 없어, 링크 클릭을 가장 먼저(capture) 받아 확인합니다.
// 브라우저 뒤로 가기는 막지 못합니다.
export function useLeaveGuard(active: boolean, message: string) {
  useEffect(() => {
    if (!active) return

    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    const onClick = (event: MouseEvent) => {
      // 새 탭으로 여는 클릭은 이 화면을 떠나지 않습니다.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === '_blank' || anchor.origin !== window.location.origin) return
      if (anchor.pathname === window.location.pathname && anchor.search === window.location.search) return
      if (!window.confirm(message)) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('click', onClick, true)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('click', onClick, true)
    }
  }, [active, message])
}
