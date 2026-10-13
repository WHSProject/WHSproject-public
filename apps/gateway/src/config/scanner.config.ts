const DEFAULT_SCANNER_URL = 'http://scanner:3001';
const DEFAULT_SCANNER_TIMEOUT_MS = 300000;

// Scanner 주소를 결정한다.
// Gateway는 기존 판정이 없는 Package만 이 주소로 분석 요청한다.
export function resolveScannerBaseUrl(): string {
  const configured = process.env.SCANNER_URL?.trim();
  const baseUrl = configured || DEFAULT_SCANNER_URL;

  return baseUrl.replace(/\/+$/, '');
}

// 분석이 끝날 때까지 기다린다. 동기 방식이므로 상한을 짧게 잡을 이유가 없다.
//
// 기본값 5분은 npm 때문에 정한 값이다. 설치하는 쪽 fetch-timeout을 360초로
// 설정하는 것을 전제로 한다(npm 기본값은 300초, 실측). 그보다 오래 기다려도
// npm이 먼저 연결을 끊는다. 그 시점부터 Gateway가 붙들고 있는 요청은 받을
// 사람이 없으므로, npm보다 조금 먼저 정리한다.
//
// 주의: 이 값은 Scanner 호출만의 상한이다. npm 요청 하나에는 Arborist 트리
// 구성, Decision 조회, Scanner 분석, Verdaccio 전달이 모두 들어가며 그 합이
// 360초를 넘으면 안 된다. 또 npm은 실패 시 2회 재시도하므로(fetch-retries
// 기본 2) 오래 걸리다 실패하면 같은 분석이 최대 세 번 반복된다.
export function resolveScannerTimeoutMs(): number {
  const configured = Number(process.env.SCANNER_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SCANNER_TIMEOUT_MS;
}

// Scanner 분석 요청을 실제로 보낼지 여부.
// 꺼져 있으면 미판정 Package는 분석·집행 없이 통과한다.
export function isScannerEnabled(): boolean {
  return process.env.SCANNER_ENABLED?.trim() === 'true';
}
