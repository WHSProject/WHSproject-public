import { Injectable } from '@nestjs/common';

import {
  resolveAnalysisCacheMaxEntries,
} from '../config/analysis-cache.config';
import type { ArtifactIdentity } from '../types/artifact.types';

// 트리 분석을 마친 Artifact를 기억한다. 한 번의 install에서 오는 tarball은
// 같은 트리에 속하므로(express 68회, 실측) 첫 분석 후엔 트리를 다시 만들지 않는다.
// 건너뛰는 건 Arborist뿐이다. Decision 조회·집행까지 건너뛰면 이 클래스가 ACCEPT 캐시가 된다.
@Injectable()
export class AnalyzedArtifactRegistry {
  // 삽입 순서를 LRU 순서로 쓴다. 참조하면 지웠다 다시 넣어 맨 뒤로 옮긴다.
  private readonly analyzed = new Map<string, ArtifactIdentity>();

  // 마지막으로 줄 선 작업이 끝나는 시점. runExclusive()가 쓴다.
  private tail: Promise<unknown> = Promise.resolve();

  // 신원을 돌려준다. 호출부가 이 값(integrity 포함)으로 Decision을 다시 조회한다.
  recall(packageName: string, version: string): ArtifactIdentity | undefined {
    const key = AnalyzedArtifactRegistry.keyOf(packageName, version);
    const artifact = this.analyzed.get(key);

    if (artifact === undefined) {
      return undefined;
    }

    this.analyzed.delete(key);
    this.analyzed.set(key, artifact);

    return artifact;
  }

  remember(artifacts: readonly ArtifactIdentity[]): void {
    const maxEntries = resolveAnalysisCacheMaxEntries();

    for (const artifact of artifacts) {
      const key = AnalyzedArtifactRegistry.keyOf(
        artifact.packageName,
        artifact.version,
      );

      this.analyzed.delete(key);
      this.analyzed.set(key, artifact);
    }

    while (this.analyzed.size > maxEntries) {
      const oldest = this.analyzed.keys().next();

      if (oldest.done) {
        break;
      }

      this.analyzed.delete(oldest.value);
    }
  }

  // 재검증에서 ACCEPT가 아닌 것으로 드러난 Artifact를 지운다.
  // 남겨 두면 단건 조회만 반복한다. 트리 전체를 다시 확인하는 편이 맞다.
  forget(packageName: string, version: string): void {
    this.analyzed.delete(AnalyzedArtifactRegistry.keyOf(packageName, version));
  }

  // 트리 분석을 직렬화한다. npm은 tarball을 동시 요청하므로(maxsockets 15, 실측)
  // 직렬화하지 않으면 동시 진입분이 같은 트리를 각자 만든다. 호출부는 task 안에서 recall()을 재확인해야 한다.
  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;

    let release!: () => void;

    // 교체가 await보다 먼저여야 한다. 순서가 뒤바뀌면 동시에 들어온 두 호출이
    // 같은 previous를 기다려 함께 실행된다.
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 앞 작업이 실패해도 뒤 작업은 진행해야 한다.
    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
    }
  }

  // 테스트에서 요청 간 상태를 분리할 때 쓴다.
  clear(): void {
    this.analyzed.clear();
  }

  get size(): number {
    return this.analyzed.size;
  }

  private static keyOf(packageName: string, version: string): string {
    return `${packageName}@${version}`;
  }
}
