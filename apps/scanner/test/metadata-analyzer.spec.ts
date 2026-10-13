import {
  MetadataAnalyzer,
  MetadataAnalyzerInput,
} from '../src/analyzers/metadata/metadata.analyzer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function input(packageJson: unknown, registryMetadata: unknown = {}): MetadataAnalyzerInput {
  return { packageJson, registryMetadata };
}

describe('MetadataAnalyzer lifecycle observations', () => {
  const analyzer = new MetadataAnalyzer();

  it.each([
    ['preinstall', 'metadata.lifecycle.preinstall', '/scripts/preinstall'],
    ['install', 'metadata.lifecycle.install', '/scripts/install'],
    ['postinstall', 'metadata.lifecycle.postinstall', '/scripts/postinstall'],
    ['prepare', 'metadata.lifecycle.prepare', '/scripts/prepare'],
  ] as const)('creates one observation for %s only', (scriptName, ruleId, jsonPointer) => {
    const observations = analyzer.findLifecycleScripts(input({
      scripts: { [scriptName]: 'echo test' },
    }));

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      ruleId,
      type: 'LIFECYCLE_SCRIPT',
      location: { type: 'METADATA', jsonPointer },
      data: { scriptName, observation: 'PRESENT' },
    });
  });

  it('creates observations for all first-phase lifecycle scripts', () => {
    const observations = analyzer.findLifecycleScripts(input({
      scripts: {
        preinstall: 'echo pre',
        install: 'echo install',
        postinstall: 'echo post',
        prepare: 'echo prepare',
      },
    }));

    expect(observations.map(({ data }) => data.scriptName)).toEqual([
      'preinstall',
      'install',
      'postinstall',
      'prepare',
    ]);
  });

  it('uses the lifecycle source Fixture as the Metadata baseline', async () => {
    const packageJson = JSON.parse(await readFile(join(
      __dirname,
      'fixtures/npm/lifecycle-scripts/package/package.json',
    ), 'utf8')) as unknown;

    const observations = analyzer.findLifecycleScripts(input(packageJson));

    expect(observations.map(({ data }) => data.scriptName)).toEqual([
      'preinstall',
      'install',
      'postinstall',
    ]);
  });

  it('uses the normal source Fixture as a no-lifecycle baseline', async () => {
    const packageJson = JSON.parse(await readFile(join(
      __dirname,
      'fixtures/npm/normal-unscoped/package/package.json',
    ), 'utf8')) as unknown;

    expect(analyzer.findLifecycleScripts(input(packageJson))).toEqual([]);
  });

  it.each([
    [undefined],
    [{}],
    [{ scripts: undefined }],
    [{ scripts: null }],
    [{ scripts: 'not-an-object' }],
    [{ scripts: [] }],
  ])('does not fail when optional metadata is absent or unexpected: %j', (packageJson) => {
    expect(() => analyzer.findLifecycleScripts(input(packageJson))).not.toThrow();
    expect(analyzer.findLifecycleScripts(input(packageJson))).toEqual([]);
  });

  it('does not create observations when scripts has no target lifecycle field', () => {
    expect(analyzer.findLifecycleScripts(input({
      scripts: { prepublishOnly: 'echo prepare', test: 'npm test' },
    }))).toEqual([]);
  });

  it('treats an empty lifecycle script value as a present field', () => {
    const observations = analyzer.findLifecycleScripts(input({
      scripts: { postinstall: '' },
    }));

    expect(observations).toHaveLength(1);
    expect(observations[0]?.data.scriptValue).toBe('');
  });

  it('uses packageJson without interpreting registry metadata', () => {
    const observations = analyzer.findLifecycleScripts(input(
      { scripts: { install: 'echo install' } },
      { scripts: { postinstall: 'registry metadata is not packageJson' } },
    ));

    expect(observations).toHaveLength(1);
    expect(observations[0]?.data.scriptName).toBe('install');
  });

  it('does not report equivalent license and repository representations as mismatches', () => {
    const result = analyzer.analyzeResult(input(
      {
        license: ' MIT  ',
        repository: { type: 'git', url: 'git+https://github.com/org/repo.git' },
      },
      {
        license: { type: 'MIT' },
        repository: 'https://github.com/org/repo/',
      },
    ), { requestId: 'request-1', scanId: 'scan-1' });

    expect(result.findings).toEqual([]);
  });

  it('does not treat HTTPS and SSH transport URLs for the same repository as a mismatch', () => {
    const result = analyzer.analyzeResult(input(
      { repository: 'https://github.com/org/repo' },
      { repository: { type: 'git', url: 'git+ssh://git@github.com/org/repo.git' } },
    ), { requestId: 'request-1', scanId: 'scan-1' });

    expect(result.findings).toEqual([]);
  });

  it('creates explicit Findings for license and repository mismatches', () => {
    const result = analyzer.analyzeResult(input(
      {
        license: 'MIT',
        repository: { type: 'git', url: 'https://github.com/tarball/project.git' },
      },
      {
        license: 'Apache-2.0',
        repository: 'git+https://github.com/registry/project',
      },
    ), { requestId: 'request-1', scanId: 'scan-1' });

    expect(result.findings).toMatchObject([
      {
        ruleId: 'metadata.license.mismatch',
        type: 'METADATA_MISMATCH',
        message: expect.stringContaining('Registry version manifest license'),
        location: { type: 'METADATA', jsonPointer: '/license' },
        data: {
          field: 'license',
          packageJsonValue: 'MIT',
          registryMetadataValue: 'Apache-2.0',
          observation: 'MISMATCH',
        },
      },
      {
        ruleId: 'metadata.repository.mismatch',
        type: 'METADATA_MISMATCH',
        message: expect.stringContaining('tarball package.json repository'),
        location: { type: 'METADATA', jsonPointer: '/repository' },
        data: {
          field: 'repository',
          packageJsonValue: 'https://github.com/tarball/project.git',
          registryMetadataValue: 'git+https://github.com/registry/project',
          observation: 'MISMATCH',
        },
      },
    ]);
  });

  it.each([
    [{}, { license: 'MIT', repository: 'https://github.com/org/repo' }],
    [{ license: 'MIT', repository: 'https://github.com/org/repo' }, {}],
    [{ license: { url: 'https://opensource.org/license/mit' }, repository: [] }, {
      license: null,
      repository: { type: 'git' },
    }],
  ])('does not report absent or unsupported comparison values: %j', (packageJson, registryMetadata) => {
    expect(analyzer.analyzeResult(
      input(packageJson, registryMetadata),
      { requestId: 'request-1', scanId: 'scan-1' },
    ).findings).toEqual([]);
  });

  it('maps lifecycle observations to the shared AnalyzerResult contract', () => {
    const result = analyzer.analyzeResult(
      input({ scripts: { postinstall: 'echo post' } }),
      { requestId: 'request-1', scanId: 'scan-1' },
    );

    expect(result).toMatchObject({
      requestId: 'request-1',
      scanId: 'scan-1',
      analyzer: 'metadata',
      analyzerVersion: '0.1.0',
      status: 'SUCCESS',
      errors: [],
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        findingId: 'metadata:metadata.lifecycle.postinstall:0',
        ruleId: 'metadata.lifecycle.postinstall',
        type: 'LIFECYCLE_SCRIPT',
        location: {
          type: 'METADATA',
          jsonPointer: '/scripts/postinstall',
        },
        data: {
          scriptName: 'postinstall',
          scriptValue: 'echo post',
          observation: 'PRESENT',
        },
      }),
    ]);
  });
});
