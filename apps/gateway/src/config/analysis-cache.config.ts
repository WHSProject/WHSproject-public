const DEFAULT_ANALYSIS_CACHE_MAX_ENTRIES = 5000;

// 분석을 마친 Artifact를 몇 개까지 기억할지 정한다.
//
// 기본값 5000은 일반적인 의존성 트리와 대형 설치를
// 수 MB 내에서 수용하기 위한 초기 운영값이다.
// 축출은 판정 정확성이 아니라 전체 재분석 빈도와 처리 시간에 영향을 준다.
//
// 축출되어도 Decision 조회는 그대로 수행되므로 판정에는 영향이 없다.
// 값이 작으면 Arborist가 더 자주 돌 뿐이다.
export function resolveAnalysisCacheMaxEntries(): number {
  const configured = Number(process.env.ANALYSIS_CACHE_MAX_ENTRIES);

  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_ANALYSIS_CACHE_MAX_ENTRIES;
}
