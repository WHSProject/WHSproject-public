import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { validateLocalArtifactBoundary } from '../src/application/local-static-analysis/local-artifact-boundary';
import { LocalStaticAnalysisService } from '../src/application/local-static-analysis/local-static-analysis.service';
import type { LocalStaticAnalysisRequest } from '../src/application/local-static-analysis/local-static-analysis.types';
import { PackageIdentityVerifier } from '../src/artifact/identity/package-identity-verifier';
import { EvidenceNormalizer } from '../src/evidence/normalizer/evidence-normalizer';
import type { AnalyzerResult } from '../src/domain/analysis.types';
import { GuardDogAnalyzer } from '../src/analyzers/guarddog/guarddog.analyzer';

const HASH = 'a'.repeat(64);

function result(analyzer: string, status: AnalyzerResult['status'] = 'SUCCESS'): AnalyzerResult {
  return { requestId: 'sample', scanId: 'scan', analyzer, analyzerVersion: '1', status, findings: [], errors: [] };
}

describe('local artifact boundary', () => {
  let root: string;
  let allowed: string;
  let packageRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-static-boundary-'));
    allowed = join(root, 'allowed');
    packageRoot = join(allowed, 'sample', 'package');
    await mkdir(packageRoot, { recursive: true });
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('allows the root itself and a nested package using canonical paths', async () => {
    await expect(validateLocalArtifactBoundary(allowed, allowed, [])).resolves.toMatchObject({ relativePackageRoot: '.' });
    await expect(validateLocalArtifactBoundary(packageRoot, allowed, [])).resolves.toMatchObject({ relativePackageRoot: 'sample/package' });
  });

  it('rejects traversal, sibling-prefix, symlink escape, missing paths, and files', async () => {
    const sibling = join(root, 'allowed-evil'); await mkdir(sibling);
    const outside = join(root, 'outside'); await mkdir(outside);
    const link = join(allowed, 'link'); await symlink(outside, link, 'dir');
    const file = join(allowed, 'file'); await writeFile(file, 'x');
    await expect(validateLocalArtifactBoundary(`${allowed}/../outside`, allowed, [])).rejects.toThrow(/parent traversal/u);
    await expect(validateLocalArtifactBoundary(sibling, allowed, [])).rejects.toThrow(/outside/u);
    await expect(validateLocalArtifactBoundary(link, allowed, [])).rejects.toThrow(/outside/u);
    await expect(validateLocalArtifactBoundary(join(allowed, 'missing'), allowed, [])).rejects.toThrow(/directory/u);
    await expect(validateLocalArtifactBoundary(file, allowed, [])).rejects.toThrow(/directory/u);
  });

  it('rejects filesystem, home, project, and scanner roots', async () => {
    await expect(validateLocalArtifactBoundary(packageRoot, '/', [])).rejects.toThrow(/too broad/u);
    await expect(validateLocalArtifactBoundary(packageRoot, homedir(), [])).rejects.toThrow(/too broad/u);
    await expect(validateLocalArtifactBoundary(packageRoot, allowed, [allowed])).rejects.toThrow(/too broad/u);
  });

  it('rejects unresolved variables and relative paths', async () => {
    await expect(validateLocalArtifactBoundary('$ARTIFACT_ROOT/package', allowed, [])).rejects.toThrow(/absolute|unresolved/u);
    await expect(validateLocalArtifactBoundary('relative/package', allowed, [])).rejects.toThrow(/absolute/u);
  });
});

describe('GuardDog external artifact boundary', () => {
  let root: string;
  let packageRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guarddog-external-'));
    packageRoot = join(root, 'sample'); await mkdir(packageRoot);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it('fails closed before spawn when network isolation is unverified', async () => {
    const runner = { run: jest.fn() };
    const analyzer = new GuardDogAnalyzer({
      executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: root,
      timeoutMs: 100, killGraceMs: 10, sandboxMode: 'REQUIRED', maxOutputBytes: 1024,
    }, { processRunner: runner, externalProcessRunner: runner });
    const context = { requestId: 'sample', scanId: 'scan' };
    const actual = await analyzer.analyzeResult({
      context: {
        ...context, package: { name: 'pkg', version: '1' },
        artifact: { tarballPath: '', extractedPath: packageRoot, hash: HASH },
        metadata: { registryMetadata: {}, packageJson: {} },
      },
      artifactBoundary: { mode: 'EXTERNAL_READ_ONLY_ARTIFACT', allowedArtifactRoot: root },
      networkIsolation: { mode: 'UNVERIFIED' },
    }, context);
    expect(actual.status).toBe('FAILED');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('allows the explicit external root only when network-none is verified', async () => {
    const runner = { run: jest.fn().mockResolvedValue({
      exitCode: 0, signal: null, stdout: JSON.stringify({
        package: packageRoot, issues: 0, results: {}, errors: {}, risks: [],
        risk_score: { score: 0, label: 'no_risks_detected', findings_count: 0, score_breakdown: {} },
      }), stderr: '',
      startedAt: new Date(0).toISOString(), completedAt: new Date(0).toISOString(), durationMs: 0,
      timedOut: false, outputLimitExceeded: false, command: [], terminationErrors: [],
    }) };
    const analyzer = new GuardDogAnalyzer({
      executable: 'guarddog', toolVersion: '3.1.0', workspaceRoot: root,
      timeoutMs: 100, killGraceMs: 10, sandboxMode: 'REQUIRED', maxOutputBytes: 1024,
    }, { processRunner: runner, externalProcessRunner: runner });
    const context = { requestId: 'sample', scanId: 'scan' };
    const actual = await analyzer.analyzeResult({
      context: {
        ...context, package: { name: 'pkg', version: '1' },
        artifact: { tarballPath: '', extractedPath: packageRoot, hash: HASH },
        metadata: { registryMetadata: {}, packageJson: {} },
      },
      artifactBoundary: { mode: 'EXTERNAL_READ_ONLY_ARTIFACT', allowedArtifactRoot: root },
      networkIsolation: { mode: 'VERIFIED_NETWORK_NONE', mechanism: 'test-network-namespace' },
    }, context);
    expect(actual.status).toBe('SUCCESS');
    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});

describe('LocalStaticAnalysisService', () => {
  let root: string;
  let allowed: string;
  let packageRoot: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-static-service-'));
    allowed = join(root, 'artifacts'); packageRoot = join(allowed, 'sample', 'package');
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0', scripts: { preinstall: 'do-not-run' } }));
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  function request(): LocalStaticAnalysisRequest {
    return { scanId: 'scan', sampleId: 'sample', packageRoot, allowedArtifactRoot: allowed,
      subject: { ecosystem: 'npm', name: 'pkg', version: '1.0.0', artifactSha256: HASH } };
  }

  function service(overrides: Record<string, unknown> = {}): LocalStaticAnalysisService {
    let evidenceId = 0;
    const dependencies = {
      guardDogAnalyzer: { version: '0.1.0', analyzeResult: jest.fn().mockResolvedValue(result('guarddog')) },
      customRuleAnalyzer: { version: '0.2.0', analyzeResult: jest.fn().mockResolvedValue(result('custom-rule')) },
      metadataAnalyzer: {
        version: '0.1.0',
        analyzeResult: jest.fn().mockImplementation((_input, context) => ({
          ...context, analyzer: 'metadata', analyzerVersion: '0.1.0', status: 'SUCCESS', errors: [],
          findings: [{ findingId: 'metadata:metadata.lifecycle.preinstall:0', ruleId: 'metadata.lifecycle.preinstall',
            type: 'LIFECYCLE_SCRIPT', message: 'present', location: { type: 'METADATA', jsonPointer: '/scripts/preinstall' }, data: {} }],
        })),
      },
      packageIdentityVerifier: new PackageIdentityVerifier(),
      integrityVerifier: { verify: jest.fn().mockResolvedValue(true) },
      evidenceNormalizer: new EvidenceNormalizer(undefined, () => `evidence-${++evidenceId}`, () => new Date(0)),
      semgrepAvailability: jest.fn().mockResolvedValue({
        available: false, reasonCode: 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE',
      }),
      guardDogSandbox: { preflight: jest.fn().mockResolvedValue({
        verified: false, mode: 'UNVERIFIED', mechanism: 'DOCKER_NETWORK_NONE',
        imageDigest: `sha256:${HASH}`, runtimeVersion: 'test', policyVersion: '1.0.0',
        mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT', rootFilesystem: 'READ_ONLY',
        resourceLimits: { pids: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 1000 },
        reasonCode: 'TEST_FAIL_CLOSED',
      }) },
      ...overrides,
    };
    return new LocalStaticAnalysisService(dependencies as never, {
      scannerRepositoryRoot: join(root, 'scanner'), projectRoot: join(root, 'project'),
      scannerCommitSha: 'commit', scannerBranch: 'branch', scannerVersion: '0.1.0',
      guardDogToolVersion: '3.1.0',
      findingSchemaHash: 'finding-hash',
      evidenceSchemaHash: 'evidence-hash', rulesetHash: 'rules-hash',
    });
  }

  it('preserves safe results and reports the precise Semgrep runtime failure', async () => {
    const actual = await service().analyze(request());
    expect(actual.status).toBe('PARTIAL');
    expect(actual.analyzerResults.find(({ name }) => name === 'custom-rule')).toMatchObject({
      status: 'UNAVAILABLE', reasonCode: 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE',
    });
    expect(actual.findings).toHaveLength(1);
    expect(actual.atomicEvidences).toHaveLength(1);
    expect(actual.provenance).toMatchObject({ executionMode: 'LOCAL_STATIC', packageExecuted: false, lifecycleExecuted: false });
    expect(JSON.stringify(actual)).not.toContain(packageRoot);
  });

  it('runs GuardDog when cheap analyzers have no signal and still completes the local pipeline', async () => {
    const guardDogAnalyzer = {
      version: '0.1.0',
      analyzeResult: jest.fn().mockResolvedValue(result('guarddog')),
    };
    const actual = await service({
      guardDogAnalyzer,
      metadataAnalyzer: {
        version: '0.1.0',
        analyzeResult: jest.fn().mockImplementation((_input, context) => ({
          ...context, analyzer: 'metadata', analyzerVersion: '0.1.0', status: 'SUCCESS', errors: [], findings: [],
        })),
      },
      semgrepAvailability: jest.fn().mockResolvedValue({ available: true }),
      customRuleSandbox: { preflight: jest.fn().mockResolvedValue({
        verified: true, mode: 'VERIFIED_NETWORK_NONE', imageDigest: `sha256:${HASH}`,
        semgrepVersion: '1.172.0', rulesetSha256: HASH, runtimeVersion: '27', policyVersion: '1.0.0',
        environmentVersion: '1.0.0', mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT_IMAGE_RULESET', rootFilesystem: 'READ_ONLY',
        resourceLimits: { pids: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 1000 },
      }) },
    }).analyze(request());
    expect(actual.status).toBe('COMPLETED');
    expect(guardDogAnalyzer.analyzeResult).toHaveBeenCalledTimes(1);
    expect(actual.analyzerResults.find(({ name }) => name === 'guarddog')).toMatchObject({ status: 'COMPLETED' });
  });

  it('rejects a hash mismatch before analyzers run', async () => {
    const guardDogAnalyzer = { version: '0.1.0', analyzeResult: jest.fn() };
    await expect(service({ integrityVerifier: { verify: jest.fn().mockResolvedValue(false) }, guardDogAnalyzer }).analyze(request()))
      .rejects.toThrow('ARTIFACT_SHA256_MISMATCH');
    expect(guardDogAnalyzer.analyzeResult).not.toHaveBeenCalled();
  });

  it('preserves metadata when GuardDog fails and treats zero findings as valid', async () => {
    const guarddog = result('guarddog', 'FAILED');
    const actual = await service({ guardDogAnalyzer: { version: '0.1.0', analyzeResult: jest.fn().mockResolvedValue(guarddog) } }).analyze(request());
    expect(actual.status).toBe('PARTIAL');
    expect(actual.analyzerResults.find(({ name }) => name === 'metadata')?.status).toBe('COMPLETED');
  });

  it('completes when all analyzers and the external Custom Rule sandbox succeed', async () => {
    const customRuleAnalyzer = { version: '0.2.0', analyzeResult: jest.fn().mockResolvedValue(result('custom-rule')) };
    const actual = await service({
      customRuleAnalyzer,
      semgrepAvailability: jest.fn().mockResolvedValue({ available: true }),
      customRuleSandbox: { preflight: jest.fn().mockResolvedValue({
        verified: true, mode: 'VERIFIED_NETWORK_NONE', imageDigest: `sha256:${HASH}`,
        semgrepVersion: '1.172.0', rulesetSha256: HASH, runtimeVersion: '27', policyVersion: '1.0.0',
        environmentVersion: '1.0.0', mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT_IMAGE_RULESET',
        rootFilesystem: 'READ_ONLY', resourceLimits: {
          pids: 64, memory: '512m', cpus: '1', tmpfsSize: '64m', timeoutMs: 1000,
        },
      }) },
    }).analyze(request());
    expect(actual.status).toBe('COMPLETED');
    expect(customRuleAnalyzer.analyzeResult).toHaveBeenCalledTimes(1);
    expect(actual.provenance.customRuleSandbox).toMatchObject({
      mode: 'VERIFIED_NETWORK_NONE', semgrepVersion: '1.172.0', rulesetSha256: HASH,
    });
  });

  it('isolates a timeout and keeps the other analyzer results', async () => {
    const timeout = result('guarddog', 'TIMEOUT');
    const actual = await service({ guardDogAnalyzer: { version: '0.1.0', analyzeResult: jest.fn().mockResolvedValue(timeout) } }).analyze(request());
    expect(actual.status).toBe('PARTIAL');
    expect(actual.analyzerResults.find(({ name }) => name === 'guarddog')?.status).toBe('TIMEOUT');
    expect(actual.findings).toHaveLength(1);
  });

  it('detects a write to the package tree', async () => {
    const guardDogAnalyzer = {
      version: '0.1.0',
      analyzeResult: jest.fn().mockImplementation(async () => {
        await writeFile(join(packageRoot, 'unexpected.txt'), 'mutation');
        return result('guarddog');
      }),
    };
    await expect(service({ guardDogAnalyzer }).analyze(request())).rejects.toThrow('PACKAGE_ROOT_WRITE_DETECTED');
  });

  it('rejects Evidence that references an unknown Finding', async () => {
    const badNormalizer = {
      normalize: jest.fn().mockReturnValue({
        atomicEvidences: [{
          schemaVersion: '0.1', evidenceId: 'bad', kind: 'ATOMIC',
          signal: { id: 'bad', type: 'BAD', category: 'CODE' },
          subject: { ecosystem: 'npm', packageName: 'pkg', packageVersion: '1', artifactHash: HASH },
          assertion: { summary: 'bad', basis: 'PATTERN_MATCH' },
          sources: [{ analyzer: 'metadata', analyzerVersion: '1', ruleId: 'bad', rawFindingId: 'missing' }],
          locations: [], provenance: { scanId: 'scan', generatedBy: 'EVIDENCE_NORMALIZER', observedAt: new Date(0).toISOString() }, limitations: [],
        }],
        unmappedFindings: [], errors: [],
        summary: { inputFindingCount: 1, normalizedFindingCount: 1, atomicEvidenceCount: 1,
          unmappedFindingCount: 0, invalidFindingCount: 0, deduplicatedEvidenceCount: 0,
          normalizerVersion: '0.1.0', mappingVersion: '0.5.0', mappingHash: 'hash' },
      }),
    };
    await expect(service({ evidenceNormalizer: badNormalizer }).analyze(request()))
      .rejects.toThrow('DANGLING_EVIDENCE_SOURCE:missing');
  });

  it('is semantically deterministic and does not expose host paths', async () => {
    const first = await service().analyze(request());
    const second = await service().analyze(request());
    const semantic = (value: typeof first) => ({
      status: value.status,
      findings: value.findings,
      atomicEvidences: value.atomicEvidences,
      relativePackageRoot: value.provenance.relativePackageRoot,
    });
    expect(semantic(first)).toEqual(semantic(second));
    expect(JSON.stringify(first)).not.toContain(root);
  });

  it('redacts container and host package roots from analyzer diagnostics', async () => {
    const guardDogAnalyzer = {
      version: '0.1.0',
      analyzeResult: jest.fn().mockResolvedValue({
        ...result('guarddog'), rawResultRef: `${packageRoot}:/analysis/package/index.js`,
      }),
    };
    const actual = await service({ guardDogAnalyzer }).analyze(request());
    expect(JSON.stringify(actual)).not.toContain(packageRoot);
    expect(JSON.stringify(actual)).not.toContain('/analysis/package');
  });
});
