// Verdaccio 승인 목록 등록 요청 본문. Decision이 전부 ACCEPT일 때만 전송한다.
export interface ApprovalRequestPackageDto {
  packageName: string;
  version: string;

  // Plugin이 빈 문자열을 거부한다
  integrity: string;
}

export interface ApprovalRequestDto {
  // 요청 추적 UUID. Plugin이 필수로 검증한다
  requestId: string;

  packages: ApprovalRequestPackageDto[];
}
