import { Injectable } from '@nestjs/common';

import { InvalidTarballPathError } from '../errors/tarball-path.errors';
import type { ParsedTarballRequest } from '../types/tarball.types';

const TARBALL_SUFFIX = '.tgz';

// 정확한 Semantic Version만 허용한다. Range·dist-tag·URL·경로는 거부한다.
// npm spec parser는 `name@<값>`의 값이 Version이 아니면 Git·원격 tarball·로컬 경로로 해석한다.
// 출처: SemVer 2.0.0 권장 정규식(https://semver.org, CC BY 3.0).
// 형식 검사만 하므로 prerelease·build 캡처 그룹을 비캡처 그룹으로 바꿨다. 허용 범위는 원본과 같다.
const EXACT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

@Injectable()
export class TarballPathParserService {
  // tarball 요청 경로에서 Package Name과 Version을 추출한다.
  //
  //   /npm/express/-/express-5.2.1.tgz       → express@5.2.1
  //   /npm/@babel/core/-/core-8.0.1.tgz      → @babel/core@8.0.1
  //
  // Scoped Package는 파일명에 Scope가 빠지고 Name만 들어간다(실측).
  // 파일을 내려받지 않고 경로 문자열만 읽는다.
  parse(packageName: string, file: string): ParsedTarballRequest {
    if (typeof packageName !== 'string' || !packageName) {
      throw new InvalidTarballPathError('package name is required');
    }

    if (typeof file !== 'string' || !file) {
      throw new InvalidTarballPathError('file name is required');
    }

    if (!file.endsWith(TARBALL_SUFFIX)) {
      throw new InvalidTarballPathError(
        `file name must end with "${TARBALL_SUFFIX}"`,
      );
    }

    // Scoped Package의 파일명은 Scope를 포함하지 않는다
    const unscopedName = packageName.startsWith('@')
      ? packageName.slice(packageName.indexOf('/') + 1)
      : packageName;

    const prefix = `${unscopedName}-`;
    const base = file.slice(0, -TARBALL_SUFFIX.length);

    if (!base.startsWith(prefix)) {
      throw new InvalidTarballPathError(
        `file name "${file}" does not match package "${packageName}"`,
      );
    }

    const version = base.slice(prefix.length);

    // Version은 이후 Arborist spec으로 조합되므로 형식을 확정한다
    if (!EXACT_SEMVER_PATTERN.test(version)) {
      throw new InvalidTarballPathError(
        `"${version}" is not an exact semantic version`,
      );
    }

    return { packageName, version };
  }
}
