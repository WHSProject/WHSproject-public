// @npmcli/arborist는 TypeScript 타입을 제공하지 않는다.
// Gateway가 실제로 사용하는 표면만 최소한으로 선언한다.
declare module '@npmcli/arborist' {
  export interface ArboristTreeNode {
    name: string;
    version: string;
    integrity: string | null;

    // Arborist가 작업 디렉터리 자신을 나타내기 위해 넣는 노드를 구분한다.
    // 실제 Package가 아니므로 검사 대상에서 제외해야 한다.
    isProjectRoot: boolean;
  }

  export interface ArboristTree {
    inventory: {
      values(): Iterable<ArboristTreeNode>;
    };
  }

  // 'all'  : 모든 위치에서 허용
  // 'root'  : 최상위 의존성에만 허용
  // 'none'  : 최상위 포함 전면 차단
  export type ArboristAllowPolicy = 'all' | 'root' | 'none';

  export interface ArboristOptions {
    // 트리를 구성할 작업 디렉터리. buildIdealTree는 이 경로에 쓰지 않는다.
    path: string;
    registry?: string;
    cache?: string;

    // 지정하지 않으면 전부 'all'로 동작하여 Git clone, 원격 tarball 다운로드,
    // 로컬 파일시스템 접근이 모두 허용된다.
    allowRegistry?: ArboristAllowPolicy;
    allowGit?: ArboristAllowPolicy;
    allowRemote?: ArboristAllowPolicy;
    allowFile?: ArboristAllowPolicy;
    allowDirectory?: ArboristAllowPolicy;
  }

  export interface BuildIdealTreeOptions {
    add: string[];
  }

  export class Arborist {
    constructor(options: ArboristOptions);

    // 메모리상 Ideal Tree만 구성한다. reify와 달리 설치를 수행하지 않는다.
    buildIdealTree(options: BuildIdealTreeOptions): Promise<ArboristTree>;
  }
}
