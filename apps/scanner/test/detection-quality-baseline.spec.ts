import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MetadataAnalyzer } from '../src/analyzers/metadata/metadata.analyzer';
import { summarizeDetectionQuality } from '../src/performance/scanner-performance';

const FIXTURE_ROOT = join(__dirname, 'fixtures', 'npm');
const LIFECYCLE_RULES = [
  'metadata.lifecycle.preinstall',
  'metadata.lifecycle.install',
  'metadata.lifecycle.postinstall',
];
const CONSISTENCY_RULES = [
  'metadata.license.mismatch',
  'metadata.repository.mismatch',
];

describe('Scanner detection quality golden corpus', () => {
  it('keeps the Metadata Analyzer exact-match baseline for existing fixtures', async () => {
    const analyzer = new MetadataAnalyzer();
    const fixtures: Array<{
      fixture: string;
      expected: readonly string[];
      registryMetadata?: Record<string, unknown>;
      registryFixture?: boolean;
    }> = [
      {
        fixture: 'normal-unscoped',
        expected: [],
        // Registry-only fields must not create findings when absent from the tarball.
        registryMetadata: {
          license: 'MIT',
          repository: 'https://github.com/whsproject/not-in-tarball',
        },
      },
      { fixture: 'normal-scoped', expected: [] },
      { fixture: 'lifecycle-scripts', expected: LIFECYCLE_RULES },
      { fixture: 'identity-mismatch', expected: [] },
      { fixture: 'metadata-consistent', expected: [], registryFixture: true },
      {
        fixture: 'metadata-mismatch',
        expected: CONSISTENCY_RULES,
        registryFixture: true,
      },
    ];

    const cases = await Promise.all(fixtures.map(async ({
      fixture,
      expected,
      registryMetadata: inlineRegistryMetadata,
      registryFixture,
    }) => {
      const packageJson = JSON.parse(await readFile(
        join(FIXTURE_ROOT, fixture, 'package', 'package.json'),
        'utf8',
      )) as unknown;
      const registryMetadata = registryFixture === true
        ? JSON.parse(await readFile(join(FIXTURE_ROOT, fixture, 'registry-metadata.json'), 'utf8')) as unknown
        : inlineRegistryMetadata ?? {};
      const result = analyzer.analyzeResult(
        { registryMetadata, packageJson },
        { requestId: `quality-${fixture}`, scanId: `quality-${fixture}` },
      );
      return {
        expected,
        actual: result.findings.map(({ ruleId }) => ruleId),
        universe: [...LIFECYCLE_RULES, ...CONSISTENCY_RULES],
      };
    }));

    expect(summarizeDetectionQuality(cases)).toMatchObject({
      caseCount: 6,
      precision: 1,
      recall: 1,
      f1: 1,
      exactMatchCount: 6,
      exactMatchRate: 1,
    });
  });
});
