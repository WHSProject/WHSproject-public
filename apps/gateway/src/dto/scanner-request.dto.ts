// Scanner 분석 요청 본문. 미판정 Package 전체를 한 번에 보낸다.
// 필드명은 DecisionLookupPackageDto와 맞춘다.
export interface ScannerRequestPackageDto {
  packageName: string;
  version: string;

  // SHA-512 SRI. 진입 전에 존재가 보장된다
  integrity: string;
}

export interface ScannerRequestDto {
  // 요청 추적 UUID
  requestId: string;

  packages: ScannerRequestPackageDto[];
}
