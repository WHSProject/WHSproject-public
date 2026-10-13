import { Injectable } from '@nestjs/common';

import { InvalidPackageNameError } from '../errors/package-name.errors';
import type { ParsedPackageName } from '../types/package-name.types';

// npm의 최대 글자 수(214)에 따른 제한
const MAX_PACKAGE_NAME_LENGTH = 214;

const SCOPED_PACKAGE_PATTERN = /^@([^/]+)\/([^/]+)$/;

@Injectable()
export class PackageNameParserService {
  // Registry 요청 경로에서 받은 Package Name을 파싱한다.
  // 경로 Parameter는 HTTP Router가 이미 Percent Decoding하므로,
  // Scoped Package는 요청 인코딩 형태와 무관하게 `@scope/name`으로 들어온다.
  parse(rawPackageName: unknown): ParsedPackageName {
    if (typeof rawPackageName !== 'string') {
      throw new InvalidPackageNameError('package name must be a string');
    }

    if (!rawPackageName) {
      throw new InvalidPackageNameError('package name is required');
    }

    if (rawPackageName.length > MAX_PACKAGE_NAME_LENGTH) {
      throw new InvalidPackageNameError(
        `package name must not exceed ${MAX_PACKAGE_NAME_LENGTH} characters`,
      );
    }

    if (rawPackageName !== rawPackageName.toLowerCase()) {
      throw new InvalidPackageNameError(
        'package name must not contain uppercase characters',
      );
    }

    if (rawPackageName.startsWith('@')) {
      return this.parseScoped(rawPackageName);
    }

    return this.parseUnscoped(rawPackageName);
  }

  private parseScoped(rawPackageName: string): ParsedPackageName {
    const matched = SCOPED_PACKAGE_PATTERN.exec(rawPackageName);

    if (!matched) {
      throw new InvalidPackageNameError(
        'scoped package name must use the "@scope/name" form',
      );
    }

    const [, scope, name] = matched;

    this.assertSegment(scope, 'scope');
    this.assertSegment(name, 'name');

    return {
      packageName: `@${scope}/${name}`,
      scope,
      name,
    };
  }

  private parseUnscoped(rawPackageName: string): ParsedPackageName {
    this.assertSegment(rawPackageName, 'name');

    return {
      packageName: rawPackageName,
      scope: null,
      name: rawPackageName,
    };
  }

  private assertSegment(segment: string, label: 'scope' | 'name'): void {
    if (segment.startsWith('.') || segment.startsWith('_')) {
      throw new InvalidPackageNameError(
        `package ${label} must not start with "." or "_"`,
      );
    }

    // Percent Encoding 시 값이 달라지면 URL-safe하지 않다
    if (encodeURIComponent(segment) !== segment) {
      throw new InvalidPackageNameError(
        `package ${label} must only contain URL-safe characters`,
      );
    }
  }
}
