const DEFAULT_DECISION_DB_URL = 'http://decision-db-api:9100';
const DEFAULT_DECISION_DB_TIMEOUT_SECONDS = 5;

// Decision DB API 주소를 결정한다.
// Gateway는 PostgreSQL에 직접 접속하지 않고 이 API를 통해 판정을 조회한다.
export function resolveDecisionDbBaseUrl(): string {
  const configured = process.env.DECISION_DB_URL?.trim();
  const baseUrl = configured || DEFAULT_DECISION_DB_URL;

  return baseUrl.replace(/\/+$/, '');
}

// 조회가 응답하지 않을 때 npm 요청이 무한정 대기하지 않도록 상한을 둔다.
// 재시도 정책은 아직 확정되지 않았다.
export function resolveDecisionDbTimeoutMs(): number {
  const configured = Number(process.env.DECISION_DB_TIMEOUT_SECONDS);

  const seconds = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_DECISION_DB_TIMEOUT_SECONDS;

  return seconds * 1000;
}
