// 세션의 User-Agent를 "브라우저 · 운영체제"로 간단히 표시합니다. 모르는 값은 "알 수 없는 기기"입니다.
const BROWSERS: [RegExp, string][] = [
  [/Edg\//u, 'Edge'],
  [/OPR\/|Opera/u, 'Opera'],
  [/Firefox\//u, 'Firefox'],
  [/Chrome\//u, 'Chrome'],
  [/Safari\//u, 'Safari'],
]

const SYSTEMS: [RegExp, string][] = [
  [/Windows/u, 'Windows'],
  [/Android/u, 'Android'],
  [/iPhone|iPad|iPod/u, 'iOS'],
  [/Mac OS X|Macintosh/u, 'macOS'],
  [/Linux/u, 'Linux'],
]

function find(value: string, table: [RegExp, string][]): string | undefined {
  return table.find(([pattern]) => pattern.test(value))?.[1]
}

export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return '알 수 없는 기기'
  const parts = [find(userAgent, BROWSERS), find(userAgent, SYSTEMS)].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '알 수 없는 기기'
}

// Better Auth는 IPv6를 /64 대역으로 줄여 저장하므로 localhost(::1)는 모두 0이 됩니다. 개발 모드에서 IP를 모르면 127.0.0.1입니다.
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '0000:0000:0000:0000:0000:0000:0000:0000'])

export function describeIp(ipAddress: string | null): string {
  if (!ipAddress) return '-'
  return LOCAL_IPS.has(ipAddress) ? '로컬 접속' : ipAddress
}
