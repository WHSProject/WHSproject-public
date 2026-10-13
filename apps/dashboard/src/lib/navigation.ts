// 페이지를 새로 불러오며 이동합니다. 로그인·로그아웃 뒤에는 이전 화면이 캐시에 남지 않도록 이 방식을 씁니다.
export function hardNavigate(url: string): void {
  window.location.assign(url)
}
