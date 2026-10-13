import { ArboristClient } from '../src/clients/arborist.client';
import {
  DependencyTreeIntegrityMissingError,
  DependencyTreeRootMissingError,
} from '../src/errors/dependency-tree.errors';
import { DependencyTreeService } from '../src/services/dependency-tree.service';
import type { DependencyTreeNode } from '../src/types/dependency-tree.types';

const REQUEST_ID = 'req-1';
const PACKAGE_NAME = 'express';
const VERSION = '4.18.2';

describe('DependencyTreeService', () => {
  let arboristClient: jest.Mocked<Pick<
    ArboristClient,
    'buildDependencyTree'
  >>;
  let service: DependencyTreeService;

  function mockTree(nodes: DependencyTreeNode[]): void {
    arboristClient.buildDependencyTree.mockResolvedValue(nodes);
  }

  function resolve(
    requestId = REQUEST_ID,
    packageName = PACKAGE_NAME,
    version = VERSION,
  ) {
    return service.resolveForVersion(requestId, packageName, version);
  }

  beforeEach(() => {
    arboristClient = { buildDependencyTree: jest.fn() };

    service = new DependencyTreeService(
      arboristClient as unknown as ArboristClient,
    );
  });

  it('builds the tree with the requested version', async () => {
    mockTree([
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
    ]);

    await resolve();

    expect(arboristClient.buildDependencyTree)
      .toHaveBeenCalledWith('express', '4.18.2');
  });

  it('returns the requested package as root', async () => {
    mockTree([
      { name: 'accepts', version: '1.3.8', integrity: 'sha512-b' },
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
    ]);

    const result = await resolve();

    expect(result.root).toEqual({
      packageName: 'express',
      version: '4.18.2',
      integrity: 'sha512-a',
    });
  });

  it('includes the root in the artifact list', async () => {
    mockTree([
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
      { name: 'accepts', version: '1.3.8', integrity: 'sha512-b' },
    ]);

    const result = await resolve();

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts).toContainEqual(result.root);
  });

  it('removes duplicate name@version entries and keeps tree order', async () => {
    mockTree([
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
      { name: 'ms', version: '2.0.0', integrity: 'sha512-c' },
      { name: 'ms', version: '2.0.0', integrity: 'sha512-c' },
      { name: 'ms', version: '2.1.3', integrity: 'sha512-d' },
    ]);

    const result = await resolve();

    expect(result.artifacts.map((a) => `${a.packageName}@${a.version}`))
      .toEqual(['express@4.18.2', 'ms@2.0.0', 'ms@2.1.3']);
  });

  it('rejects a dependency when integrity is missing', async () => {
    mockTree([
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
      { name: 'local-dep', version: '1.0.0', integrity: null },
    ]);

    await expect(resolve())
      .rejects.toBeInstanceOf(DependencyTreeIntegrityMissingError);

    await expect(resolve())
      .rejects.toThrow(
        'integrity is required for package "local-dep@1.0.0"',
      );
  });

  it('keeps the request ID', async () => {
    mockTree([
      { name: 'express', version: '4.18.2', integrity: 'sha512-a' },
    ]);

    const result = await resolve('req-trace-42');

    expect(result.requestId).toBe('req-trace-42');
  });

  it('resolves a scoped package name', async () => {
    mockTree([
      { name: '@nestjs/core', version: '11.2.1', integrity: 'sha512-e' },
    ]);

    const result = await resolve(REQUEST_ID, '@nestjs/core', '11.2.1');

    expect(result.root.packageName).toBe('@nestjs/core');
  });

  it('fails when the requested package is missing from the tree', async () => {
    mockTree([
      { name: 'accepts', version: '1.3.8', integrity: 'sha512-b' },
    ]);

    await expect(resolve())
      .rejects.toBeInstanceOf(DependencyTreeRootMissingError);
  });

  it('fails when the tree contains a different version of the package',
    async () => {
      mockTree([
        { name: 'express', version: '4.17.0', integrity: 'sha512-old' },
      ]);

      await expect(resolve())
        .rejects.toThrow('express@4.18.2');
    });
});
