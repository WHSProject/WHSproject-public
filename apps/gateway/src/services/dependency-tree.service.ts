import { Injectable } from '@nestjs/common';

import { ArboristClient } from '../clients/arborist.client';
import {
  DependencyTreeIntegrityMissingError,
  DependencyTreeRootMissingError,
} from '../errors/dependency-tree.errors';
import type { ArtifactIdentity } from '../types/artifact.types';
import type {
  DependencyResolutionResult,
  DependencyTreeNode,
} from '../types/dependency-tree.types';

@Injectable()
export class DependencyTreeService {
  constructor(private readonly arboristClient: ArboristClient) {}

  // 정확한 Version을 이미 알고 있을 때 사용한다.
  //
  // tarball 요청 경로에는 Version이 그대로 들어 있어 추측할 필요가 없다.
  // package-lock.json이 있으면 Metadata 요청 자체가 발생하지 않으므로,
  // 검사가 반드시 동작해야 하는 지점은 tarball 요청이다(실측).
  async resolveForVersion(
    requestId: string,
    packageName: string,
    version: string,
  ): Promise<DependencyResolutionResult> {
    const nodes = await this.arboristClient.buildDependencyTree(
      packageName,
      version,
    );

    const artifacts = this.toUniqueArtifacts(nodes);

    // 요청한 Package는 트리의 최상위가 아니라 일반 노드로 들어간다.
    // Arborist의 최상위는 임시 작업 디렉터리이기 때문이다.
    const root = artifacts.find(
      (artifact) => artifact.packageName === packageName
        && artifact.version === version,
    );

    if (!root) {
      throw new DependencyTreeRootMissingError(`${packageName}@${version}`);
    }

    return {
      requestId,
      root,
      artifacts,
    };
  }

  // 같은 Package가 여러 경로에 나타날 수 있으므로 name@version 기준으로
  // 중복을 제거한다. 트리 순회 순서는 유지한다.
  private toUniqueArtifacts(
    nodes: DependencyTreeNode[],
  ): ArtifactIdentity[] {
    const unique = new Map<string, ArtifactIdentity>();

    for (const node of nodes) {
      const key = `${node.name}@${node.version}`;

      // Policy / Decision DB Contract에서 integrity는 필수다.
      // 오래된 npm Package 등에서 integrity가 없는 경우 downstream에
      // null을 전달하지 않고 Gateway에서 즉시 중단한다.
      if (node.integrity === null || node.integrity.trim() === '') {
        throw new DependencyTreeIntegrityMissingError(key);
      }

      if (unique.has(key)) {
        continue;
      }

      unique.set(key, {
        packageName: node.name,
        version: node.version,
        integrity: node.integrity,
      });
    }

    return [...unique.values()];
  }
}
