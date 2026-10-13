const DEFAULT_VERDACCIO_URL = 'http://verdaccio:4873';
const DEFAULT_VERDACCIO_TIMEOUT_MS = 60000;

// Verdaccio 주소를 결정한다.
// Gateway는 이 주소로 npm Registry 요청을 중계한다.
export function resolveVerdaccioBaseUrl(): string {
  const configured = process.env.VERDACCIO_URL?.trim();
  const baseUrl = configured || DEFAULT_VERDACCIO_URL;

  return baseUrl.replace(/\/+$/, '');
}

// Verdaccio가 응답하지 않을 때 npm 요청이 무한정 대기하지 않도록 상한을 둔다.
// tarball 전송이 포함되므로 Decision 조회보다 넉넉하게 잡는다.
export function resolveVerdaccioTimeoutMs(): number {
  const configured = Number(process.env.VERDACCIO_TIMEOUT_MS);

  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_VERDACCIO_TIMEOUT_MS;
}

// Gateway와 Verdaccio가 공유하는 Approval API 서비스 토큰
export function resolveApprovalServiceToken(): string | undefined {
  const token = process.env.WHS_APPROVAL_SERVICE_TOKEN?.trim();

  return token || undefined;
}