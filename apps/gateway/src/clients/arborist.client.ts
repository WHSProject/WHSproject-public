import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { Arborist } from '@npmcli/arborist';
import type { ArboristTree } from '@npmcli/arborist';

import { resolveNpmRegistryBaseUrl } from '../config/npm-registry.config';
import { DependencyTreeBuildError } from '../errors/dependency-tree.errors';
import type { DependencyTreeNode } from '../types/dependency-tree.types';

const WORK_DIR_PREFIX = 'whs-gateway-arborist-';

// Registry 외 의존성(Git·원격 tarball·로컬 경로)을 차단한다.
// 기본값 'all'이면 buildIdealTree만으로 clone·다운로드·파일 접근이 발생해
// 악성 Package가 Gateway의 외부 요청을 유도할 수 있다.
// 최상위 spec도 Registry에서 온 값이라 'root'가 아닌 'none'이다.
const REGISTRY_ONLY_POLICY = {
  allowRegistry: 'all',
  allowGit: 'none',
  allowRemote: 'none',
  allowFile: 'none',
  allowDirectory: 'none',
} as const;

@Injectable()
export class ArboristClient {
  // 지정한 Package의 의존성 트리를 구성하고 노드 목록을 반환한다.
  //
  // buildIdealTree는 메모리상 트리만 만들며 tarball을 내려받거나
  // node_modules를 생성하지 않는다. 다만 Package Metadata 요청은
  // Arborist가 자체적으로 수행한다.
  async buildDependencyTree(
    packageName: string,
    version: string,
  ): Promise<DependencyTreeNode[]> {
    const spec = `${packageName}@${version}`;

    // Arborist는 작업 디렉터리를 요구한다. 실제로 쓰지는 않지만
    // 요청 간 상태가 섞이지 않도록 요청마다 새로 만들고 정리한다.
    const workDir = await mkdtemp(join(tmpdir(), WORK_DIR_PREFIX));

    try {
      const arborist = new Arborist({
        path: workDir,
        registry: `${resolveNpmRegistryBaseUrl()}/`,
        ...REGISTRY_ONLY_POLICY,
      });

      const tree = await arborist.buildIdealTree({ add: [spec] });

      return this.collectNodes(tree);
    } catch (error) {
      throw new DependencyTreeBuildError(spec, error);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private collectNodes(tree: ArboristTree): DependencyTreeNode[] {
    const nodes: DependencyTreeNode[] = [];

    for (const node of tree.inventory.values()) {
      // Arborist는 작업 디렉터리 자신을 노드로 트리에 포함시킨다.
      // 실제 Package가 아니므로 검사 대상에서 제외한다.
      if (node.isProjectRoot) {
        continue;
      }

      // 위 조건에서 걸러지지 않는 비정상 노드에 대한 방어
      if (typeof node.name !== 'string' || !node.name) {
        continue;
      }

      if (typeof node.version !== 'string' || !node.version) {
        continue;
      }

      nodes.push({
        name: node.name,
        version: node.version,
        integrity: node.integrity ?? null,
      });
    }

    return nodes;
  }
}
