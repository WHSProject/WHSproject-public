// Decision DB 조회 요청 본문. 의존성 전체를 한 번에 조회한다.
export interface DecisionLookupPackageDto {
  packageName: string;
  version: string;

  // SHA-512 SRI. 진입 전에 존재가 보장된다
  integrity: string;
}

export interface DecisionLookupRequestDto {
  // 요청 추적 UUID
  requestId: string;

  packages: DecisionLookupPackageDto[];
}
