import {
  AnalyzedArtifactRegistry,
} from '../src/cache/analyzed-artifact.registry';
import type { ArtifactIdentity } from '../src/types/artifact.types';

function artifact(
  packageName: string,
  version = '1.0.0',
  integrity: string = `sha512-${packageName}`,
): ArtifactIdentity {
  return { packageName, version, integrity };
}

describe('AnalyzedArtifactRegistry', () => {
  let registry: AnalyzedArtifactRegistry;
  const originalMaxEntries = process.env.ANALYSIS_CACHE_MAX_ENTRIES;

  beforeEach(() => {
    registry = new AnalyzedArtifactRegistry();
  });

  afterEach(() => {
    if (originalMaxEntries === undefined) {
      delete process.env.ANALYSIS_CACHE_MAX_ENTRIES;
    } else {
      process.env.ANALYSIS_CACHE_MAX_ENTRIES = originalMaxEntries;
    }
  });

  describe('기억과 회수', () => {
    it('기억하지 않은 Artifact는 회수되지 않는다', () => {
      expect(registry.recall('lodash', '4.17.21')).toBeUndefined();
    });

    // 판정을 다시 조회하려면 integrity가 필요하다.
    // boolean이 아니라 신원을 돌려주는 이유다.
    it('기억한 Artifact를 integrity까지 그대로 돌려준다', () => {
      registry.remember([artifact('lodash', '4.17.21', 'sha512-lodash')]);

      expect(registry.recall('lodash', '4.17.21')).toEqual({
        packageName: 'lodash',
        version: '4.17.21',
        integrity: 'sha512-lodash',
      });
    });

    it('Version이 다르면 별개로 취급한다', () => {
      registry.remember([artifact('lodash', '4.17.21')]);

      expect(registry.recall('lodash', '4.17.20')).toBeUndefined();
    });

    it('트리 전체를 한 번에 기억한다', () => {
      registry.remember([
        artifact('express', '4.18.2'),
        artifact('accepts', '1.3.8'),
        artifact('ms', '2.1.3'),
      ]);

      expect(registry.recall('express', '4.18.2')).toBeDefined();
      expect(registry.recall('accepts', '1.3.8')).toBeDefined();
      expect(registry.recall('ms', '2.1.3')).toBeDefined();
      expect(registry.size).toBe(3);
    });

    it('같은 Artifact를 다시 기억해도 늘어나지 않는다', () => {
      registry.remember([artifact('lodash', '4.17.21')]);
      registry.remember([artifact('lodash', '4.17.21')]);

      expect(registry.size).toBe(1);
    });

    it('forget으로 지운 Artifact는 회수되지 않는다', () => {
      registry.remember([artifact('lodash', '4.17.21')]);

      registry.forget('lodash', '4.17.21');

      expect(registry.recall('lodash', '4.17.21')).toBeUndefined();
    });

    it('기억하지 않은 Artifact를 forget해도 오류가 나지 않는다', () => {
      expect(() => registry.forget('nothing', '1.0.0')).not.toThrow();
    });

    it('clear로 전부 비운다', () => {
      registry.remember([artifact('lodash', '4.17.21')]);

      registry.clear();

      expect(registry.size).toBe(0);
    });
  });

  describe('LRU 상한', () => {
    function fill(count: number): void {
      registry.remember(
        Array.from({ length: count }, (unused, index) => artifact(
          `pkg-${index}`,
        )),
      );
    }

    it('환경변수로 상한을 지정한다', () => {
      process.env.ANALYSIS_CACHE_MAX_ENTRIES = '3';

      fill(5);

      expect(registry.size).toBe(3);
    });

    it('상한을 넘으면 가장 오래된 항목부터 밀려난다', () => {
      process.env.ANALYSIS_CACHE_MAX_ENTRIES = '3';

      fill(3);
      registry.remember([artifact('newest')]);

      expect(registry.recall('pkg-0', '1.0.0')).toBeUndefined();
      expect(registry.recall('newest', '1.0.0')).toBeDefined();
      expect(registry.size).toBe(3);
    });

    // 참조된 항목은 최근 항목으로 옮겨져 다음 축출 대상에서 벗어난다.
    it('회수한 항목은 축출 순서가 뒤로 밀린다', () => {
      process.env.ANALYSIS_CACHE_MAX_ENTRIES = '3';

      fill(3);

      expect(registry.recall('pkg-0', '1.0.0')).toBeDefined();

      registry.remember([artifact('newest')]);

      expect(registry.recall('pkg-0', '1.0.0')).toBeDefined();
      expect(registry.recall('pkg-1', '1.0.0')).toBeUndefined();
    });

    it('환경변수가 없으면 기본값 5000을 쓴다', () => {
      delete process.env.ANALYSIS_CACHE_MAX_ENTRIES;

      fill(5001);

      expect(registry.size).toBe(5000);
    });

    it.each(['0', '-1', 'abc', '1.5', ''])(
      '잘못된 상한 %p 이면 기본값으로 떨어진다',
      (value) => {
        process.env.ANALYSIS_CACHE_MAX_ENTRIES = value;

        fill(5001);

        expect(registry.size).toBe(5000);
      },
    );
  });

  describe('분석 직렬화', () => {
    it('동시에 들어온 작업이 겹쳐 실행되지 않는다', async () => {
      let running = 0;
      let maxConcurrent = 0;

      const task = async (): Promise<void> => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);

        await Promise.resolve();

        running -= 1;
      };

      await Promise.all(
        Array.from({ length: 15 }, () => registry.runExclusive(task)),
      );

      expect(maxConcurrent).toBe(1);
    });

    it('등록된 순서대로 실행한다', async () => {
      const order: number[] = [];

      await Promise.all(
        Array.from({ length: 5 }, (unused, index) => registry.runExclusive(
          async () => {
            await Promise.resolve();

            order.push(index);
          },
        )),
      );

      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    it('작업의 반환값을 그대로 전달한다', async () => {
      await expect(registry.runExclusive(async () => 'done')).resolves
        .toBe('done');
    });

    it('작업이 실패하면 예외가 호출부로 올라간다', async () => {
      await expect(
        registry.runExclusive(async () => {
          throw new Error('analysis failed');
        }),
      ).rejects.toThrow('analysis failed');
    });

    // 앞 작업이 실패했다고 뒤 작업까지 막히면 요청 하나가 이후 전체를
    // 영구히 멈추게 한다.
    it('앞 작업이 실패해도 다음 작업은 실행된다', async () => {
      const failed = registry.runExclusive(async () => {
        throw new Error('analysis failed');
      });

      await expect(failed).rejects.toThrow('analysis failed');

      await expect(registry.runExclusive(async () => 'next')).resolves
        .toBe('next');
    });

    // 동시 진입분이 한 번의 분석으로 접히는지 확인한다.
    it('앞 작업이 기억을 마치면 뒤 작업은 재확인에서 걸러진다', async () => {
      const tree = [
        artifact('express', '4.18.2'),
        artifact('accepts', '1.3.8'),
        artifact('ms', '2.1.3'),
      ];

      let analyses = 0;

      const analyze = async (target: ArtifactIdentity): Promise<void> => {
        if (registry.recall(target.packageName, target.version)) {
          return;
        }

        await registry.runExclusive(async () => {
          if (registry.recall(target.packageName, target.version)) {
            return;
          }

          analyses += 1;

          await Promise.resolve();

          registry.remember(tree);
        });
      };

      await Promise.all(tree.map(analyze));

      expect(analyses).toBe(1);
    });
  });
});
