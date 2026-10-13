import {
  BadRequestException,
} from '@nestjs/common';

import {DependencyTreeIntegrityMissingError} from '../errors/dependency-tree.errors';
import {InvalidPackageNameError} from '../errors/package-name.errors';
import {InvalidTarballPathError} from '../errors/tarball-path.errors';

// 도메인 에러를 HTTP 예외로 변환한다.
// 상태 코드만 정하고, 응답 본문의 error.code는 GatewayExceptionFilter가 결정한다.
export function toHttpException(error: unknown): unknown {
  // 잘못된 패키지명·tarball 경로·integrity 누락
  if (
    error instanceof InvalidPackageNameError
    || error instanceof InvalidTarballPathError
    || error instanceof DependencyTreeIntegrityMissingError
  ) {
    return new BadRequestException(error.message);
  }

  // 인증/권한 및 PackageNotAllowedError는 종류를 보존해 필터에서 구분한다.
  return error;
}
