import '@testing-library/jest-dom/vitest'

// jsdom에는 브라우저의 matchMedia가 없으므로 기본 라이트 환경을 제공합니다.
if (typeof window !== 'undefined') Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  writable: true,
  value: (query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
  }),
})
