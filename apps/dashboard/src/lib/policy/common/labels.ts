import type { MinimumSupport, OnUnknown } from './types'

// 조건(predicate)·분류·고급 설정의 화면 표시 이름입니다. 화면에서만 쓰고, 저장·Policy 전달은 항상 원래 코드로 합니다.
// 조건 이름은 Policy 등록 설명(infra/postgres/migrations/policy/003_predicate_registry.sql)을 바탕으로 정했습니다.
// 목록에 없는 새 조건은 코드를 그대로 보여 줍니다.

export const MINIMUM_SUPPORT_LABELS: Record<MinimumSupport, string> = {
  SUPPORTED: '분석이 모두 끝난 경우에만 적용',
  PARTIAL: '일부만 분석돼도 적용',
}

export const ON_UNKNOWN_LABELS: Record<OnUnknown, string> = {
  HOLD: '보류(HOLD)',
  REVIEW: '검토(REVIEW)',
  IGNORE: '이 Rule 무시',
}

const PREDICATE_LABELS: Record<string, string> = {
  LIFECYCLE_TRIGGERED: '설치·실행 훅에서 동작',
  EXECUTION_PATH_REACHABLE: '실행 경로에서 도달 가능',
  SENSITIVE_DATA_ACCESSED: '민감 데이터 접근',
  DATA_REACHES_EXTERNAL_SINK: '데이터 외부 전송',
  DATA_REACHES_PROCESS_EXECUTION: '데이터가 명령 실행으로 전달',
  BENIGN_ALTERNATIVE_SUPPORTED: '정상 동작 근거 확인',
  BENIGN_ALTERNATIVE_NOT_SUPPORTED: '정상 동작 근거 없음',
  FUNCTIONALITY_MISMATCH: '패키지 기능과 무관한 동작',
  REFERENCE_VALID: '패키지 정보·참조 근거 확인',
  INDEPENDENT_SUPPORT_PRESENT: '독립된 근거로 교차 확인',
  DECISIVE_LINK_UNRESOLVED: '판단에 필요한 연결 미확인',
  ANALYSIS_COVERAGE_INCOMPLETE: '분석 범위 불완전',
  OSV_ADVISORY_APPLIES: 'OSV 취약점 해당',
  ARTIFACT_IDENTITY_MATCHES: '요청 패키지와 파일 일치',
  PACKAGE_INSTALL_SCRIPT_PRESENT: '설치 스크립트 포함',
  NETWORK_REQUEST_INITIATED: '외부 네트워크 요청',
  CHILD_PROCESS_SPAWNED: '하위 프로세스·셸 실행',
  CREDENTIAL_SOURCE_ACCESSED: '인증 정보 접근',
  REMOTE_CODE_FETCH: '원격 코드 다운로드',
  NATIVE_BINARY_LOADED: '네이티브 바이너리 로드',
  OBFUSCATION_PRESENT: '코드 난독화',
}

const CATEGORY_LABELS: Record<string, string> = {
  coverage: '분석 범위',
  identity: '패키지 식별',
  context: '맥락',
  execution: '실행',
  data: '데이터',
  corroboration: '교차 확인',
  network: '네트워크',
  analysis: '코드 분석',
  feed: '외부 피드',
}

export function predicateLabel(code: string): string {
  return Object.hasOwn(PREDICATE_LABELS, code) ? PREDICATE_LABELS[code] : code
}

export function categoryLabel(category: string): string {
  return Object.hasOwn(CATEGORY_LABELS, category) ? CATEGORY_LABELS[category] : category
}
