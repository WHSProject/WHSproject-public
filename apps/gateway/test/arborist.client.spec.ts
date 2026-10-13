import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArboristClient } from '../src/clients/arborist.client';
import { DependencyTreeBuildError } from '../src/errors/dependency-tree.errors';

// 실제 Arborist를 사용한다. 아래 케이스는 차단이 fetch 이전 단계에서
// 발생하므로 Registry 요청이 나가지 않는다.
describe('ArboristClient — Registry 외 의존성 차단', () => {
  const client = new ArboristClient();

  let localPackageDir: string;

  beforeAll(async () => {
    localPackageDir = await mkdtemp(join(tmpdir(), 'whs-local-pkg-'));

    await writeFile(
      join(localPackageDir, 'package.json'),
      JSON.stringify({ name: 'local-package', version: '9.9.9' }),
    );
  });

  afterAll(async () => {
    await rm(localPackageDir, { recursive: true, force: true });
  });

  it('rejects a local directory dependency', async () => {
    await expect(
      client.buildDependencyTree('local-package', `file:${localPackageDir}`),
    ).rejects.toBeInstanceOf(DependencyTreeBuildError);
  });

  it('rejects a git dependency', async () => {
    await expect(
      client.buildDependencyTree(
        'evil',
        'git+https://example.invalid/repo.git',
      ),
    ).rejects.toBeInstanceOf(DependencyTreeBuildError);
  });

  it('rejects a remote tarball dependency', async () => {
    await expect(
      client.buildDependencyTree(
        'evil',
        'https://example.invalid/package.tgz',
      ),
    ).rejects.toBeInstanceOf(DependencyTreeBuildError);
  });

  it('reports the blocking reason as the error cause', async () => {
    const error = await client
      .buildDependencyTree('local-package', `file:${localPackageDir}`)
      .catch((caught: unknown) => caught) as DependencyTreeBuildError;

    // pacote가 차단 시 EALLOW<TYPE> 코드를 붙인다
    expect((error.cause as { code?: string }).code)
      .toMatch(/^EALLOW(DIRECTORY|FILE)$/);
  });

  it('does not leave the temporary work directory behind', async () => {
    const fs = await import('node:fs/promises');
    const originalMkdtemp = fs.mkdtemp;
    const created: string[] = [];

    // 이 호출이 만든 디렉토리만 추적한다. tmpdir 전체를 스캔하면
    // 병렬로 도는 다른 spec의 디렉토리를 잡는다.
    const spy = jest.spyOn(fs, 'mkdtemp').mockImplementation((async (prefix: string) => {
      const dir = await originalMkdtemp(prefix);
      created.push(dir);
      return dir;
    }) as typeof fs.mkdtemp);

    try {
      await client
        .buildDependencyTree('local-package', `file:${localPackageDir}`)
        .catch(() => undefined);
    } finally {
      spy.mockRestore();
    }

    expect(created).toHaveLength(1);
    await expect(fs.access(created[0])).rejects.toThrow();
  });
});
