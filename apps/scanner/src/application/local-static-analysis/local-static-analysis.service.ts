import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import type { AnalyzerResult, AnalysisContext, Finding, ScanError } from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import type { GuardDogAnalyzer } from '../../analyzers/guarddog/guarddog.analyzer';
import type { CustomRuleAnalyzer } from '../../analyzers/custom-rule/custom-rule.analyzer';
import type { MetadataAnalyzer } from '../../analyzers/metadata/metadata.analyzer';
import type { PackageIdentityVerifier } from '../../artifact/identity/package-identity-verifier';
import { EvidenceNormalizer } from '../../evidence/normalizer/evidence-normalizer';
import {
  EVIDENCE_MAPPING_VERSION,
} from '../../evidence/normalizer/evidence-mapping.registry';
import {
  GUARDDOG_ENVIRONMENT_ALLOWLIST_VERSION,
} from '../../analyzers/guarddog/guarddog-process.runner';
import type { ExternalGuardDogSandboxPort } from '../../analyzers/guarddog/docker-external-guarddog.runner';
import type { ExternalCustomRuleSandboxPort } from '../../analyzers/custom-rule/docker-external-custom-rule.runner';
import {
  decideGuardDogExecution,
  skippedGuardDogResult,
} from '../../analyzers/guarddog/guarddog-execution-policy';
import { validateLocalArtifactBoundary } from './local-artifact-boundary';
import type { AtomicSmokeInvocationBudget, SmokeAnalyzerName, SmokeBackendAttestation } from './smoke-invocation-budget';
import type {
  LocalAnalyzerExecution,
  LocalAnalyzerStatus,
  LocalArtifactIntegrityVerifier,
  LocalStaticAnalysisRequest,
  LocalStaticAnalysisResult,
  SemgrepAvailability,
} from './local-static-analysis.types';

export interface LocalStaticAnalysisDependencies {
  guardDogAnalyzer: GuardDogAnalyzer;
  customRuleAnalyzer: CustomRuleAnalyzer;
  metadataAnalyzer: MetadataAnalyzer;
  packageIdentityVerifier: PackageIdentityVerifier;
  integrityVerifier: LocalArtifactIntegrityVerifier;
  evidenceNormalizer: EvidenceNormalizer;
  semgrepAvailability: () => Promise<SemgrepAvailability>;
  guardDogSandbox: ExternalGuardDogSandboxPort;
  customRuleSandbox?: ExternalCustomRuleSandboxPort;
  invocationBudget?: AtomicSmokeInvocationBudget;
  invocationBackendAttestation?: SmokeBackendAttestation;
}

export interface LocalStaticAnalysisOptions {
  scannerRepositoryRoot: string;
  projectRoot: string;
  scannerCommitSha: string;
  scannerBranch: string;
  scannerVersion: string;
  guardDogToolVersion: string;
  findingSchemaHash: string;
  evidenceSchemaHash: string;
  rulesetHash: string;
}

export class LocalStaticAnalysisService {
  constructor(
    private readonly dependencies: LocalStaticAnalysisDependencies,
    private readonly options: LocalStaticAnalysisOptions,
  ) {}

  async analyze(request: LocalStaticAnalysisRequest): Promise<LocalStaticAnalysisResult> {
    const boundary = await validateLocalArtifactBoundary(
      request.packageRoot,
      request.allowedArtifactRoot,
      [this.options.projectRoot, this.options.scannerRepositoryRoot],
    );
    if (!/^[a-f0-9]{64}$/u.test(request.subject.artifactSha256)) {
      throw new Error('ARTIFACT_SHA256_INVALID');
    }
    if (!await this.dependencies.integrityVerifier.verify(request)) {
      throw new Error('ARTIFACT_SHA256_MISMATCH');
    }

    const packageJson = await this.dependencies.packageIdentityVerifier.verifyPackageRoot(
      boundary.packageRoot,
      { name: request.subject.name, version: request.subject.version },
    );
    const before = await directoryDigest(boundary.packageRoot);
    const sandbox = await this.dependencies.guardDogSandbox.preflight(boundary.packageRoot);
    const customRuleSandbox = this.dependencies.customRuleSandbox === undefined
      ? undefined
      : await this.dependencies.customRuleSandbox.preflight(boundary.packageRoot);
    const context: AnalysisContext = {
      requestId: request.sampleId,
      scanId: request.scanId,
      package: { name: request.subject.name, version: request.subject.version },
      artifact: {
        tarballPath: '',
        extractedPath: boundary.packageRoot,
        hash: request.subject.artifactSha256,
      },
      metadata: { registryMetadata: {}, packageJson },
    };
    const analyzerContext = { requestId: request.sampleId, scanId: request.scanId };

    const metadataExecution = await this.runBudgeted(request.sampleId, 'metadata', () => this.dependencies.metadataAnalyzer.analyzeResult(
      { registryMetadata: {}, packageJson }, analyzerContext,
    ));
    const customRuleExecution = await this.runCustomRule(request.sampleId, boundary.packageRoot, packageJson, analyzerContext,
      customRuleSandbox?.verified === false ? customRuleSandbox.reasonCode : undefined);
    const guardDogDecision = decideGuardDogExecution(metadataExecution.result, customRuleExecution.result);
    const guardDogExecution = guardDogDecision.shouldRun
      ? await this.runBudgeted(request.sampleId, 'guarddog', () => this.dependencies.guardDogAnalyzer.analyzeResult({
        context,
        artifactBoundary: {
          mode: 'EXTERNAL_READ_ONLY_ARTIFACT',
          allowedArtifactRoot: boundary.allowedArtifactRoot,
        },
        networkIsolation: sandbox.verified
          ? { mode: 'VERIFIED_NETWORK_NONE', mechanism: sandbox.mechanism }
          : { mode: 'UNVERIFIED' },
      }, analyzerContext))
      : {
        name: 'guarddog',
        status: 'SKIPPED' as const,
        result: skippedGuardDogResult(analyzerContext, this.dependencies.guardDogAnalyzer.version),
        durationMs: 0,
        reasonCode: guardDogDecision.reason,
      };
    const executions = [metadataExecution, customRuleExecution, guardDogExecution];

    const after = await directoryDigest(boundary.packageRoot);
    if (before !== after) throw new Error('PACKAGE_ROOT_WRITE_DETECTED');

    const analyzerResults = executions.map((execution) => ({
      ...execution,
      result: redactAnalyzerResult(execution.result, [boundary.packageRoot, request.packageRoot]),
    }));
    const canonicalResults = executions.map(({ result }) => result);
    const findings = canonicalResults.flatMap(({ findings }) => findings);
    assertUniqueFindingIds(findings);
    const normalization = this.dependencies.evidenceNormalizer.normalize({
      requestId: request.sampleId,
      scanId: request.scanId,
      subject: {
        ecosystem: 'npm',
        packageName: request.subject.name,
        packageVersion: request.subject.version,
        artifactHash: request.subject.artifactSha256,
      },
      artifactRoot: boundary.packageRoot,
      analyzerResults: canonicalResults,
    });
    assertEvidenceSources(findings, normalization.atomicEvidences);
    const successful = executions.filter(({ status }) => status === 'COMPLETED' || status === 'SKIPPED').length;
    const status = successful === executions.length
      ? 'COMPLETED'
      : successful > 0 ? 'PARTIAL' : 'FAILED';
    const failures = [
      ...canonicalResults.flatMap(({ errors }) => errors),
      ...normalization.errors,
    ];

    return {
      status,
      analyzerResults,
      findings,
      atomicEvidences: normalization.atomicEvidences,
      correlatedEvidences: [],
      failures,
      unmappedFindings: normalization.unmappedFindings,
      normalizationSummary: normalization.summary,
      provenance: {
        scannerCommitSha: this.options.scannerCommitSha,
        scannerBranch: this.options.scannerBranch,
        scannerVersion: this.options.scannerVersion,
        executionMode: 'LOCAL_STATIC',
        artifactBoundaryMode: 'EXTERNAL_READ_ONLY_ARTIFACT',
        allowedRootId: boundary.allowedRootId,
        relativePackageRoot: boundary.relativePackageRoot,
        artifactSha256: request.subject.artifactSha256,
        packageTreeDigest: before,
        analyzerVersions: Object.fromEntries(executions.map(({ name, result }) => [name, result.analyzerVersion])),
        guardDogVersion: this.options.guardDogToolVersion,
        customRuleRulesetHash: this.options.rulesetHash,
        metadataAnalyzerVersion: this.dependencies.metadataAnalyzer.version,
        analyzerExecutions: executions.map(({ name, status: analyzerStatus, durationMs }) => ({
          name, status: analyzerStatus, durationMs,
        })),
        findingSchema: { version: '0.1', hash: this.options.findingSchemaHash },
        evidenceSchema: { version: '0.1', hash: this.options.evidenceSchemaHash },
        evidenceMapping: {
          version: EVIDENCE_MAPPING_VERSION,
          hash: normalization.summary.mappingHash,
        },
        networkIsolationMode: sandbox.mode,
        sandbox: {
          backend: sandbox.mechanism,
          imageDigest: sandbox.imageDigest,
          runtimeVersion: sandbox.runtimeVersion,
          policyVersion: sandbox.policyVersion,
          mountPolicy: sandbox.mountPolicy,
          rootFilesystem: sandbox.rootFilesystem,
          resourceLimits: sandbox.resourceLimits,
          ...(sandbox.reasonCode === undefined ? {} : { verificationReasonCode: sandbox.reasonCode }),
        },
        ...(customRuleSandbox === undefined ? {} : { customRuleSandbox: {
          mode: customRuleSandbox.mode,
          imageDigest: customRuleSandbox.imageDigest,
          semgrepVersion: customRuleSandbox.semgrepVersion,
          rulesetSha256: customRuleSandbox.rulesetSha256,
          runtimeVersion: customRuleSandbox.runtimeVersion,
          policyVersion: customRuleSandbox.policyVersion,
          environmentVersion: customRuleSandbox.environmentVersion,
          mountPolicy: customRuleSandbox.mountPolicy,
          rootFilesystem: customRuleSandbox.rootFilesystem,
          resourceLimits: customRuleSandbox.resourceLimits,
          ...(customRuleSandbox.reasonCode === undefined ? {} : { verificationReasonCode: customRuleSandbox.reasonCode }),
        } }),
        environmentAllowlistVersion: GUARDDOG_ENVIRONMENT_ALLOWLIST_VERSION,
        packageExecuted: false,
        lifecycleExecuted: false,
      },
    };
  }

  private async runCustomRule(
    sampleId: string,
    packageRoot: string,
    packageJson: Record<string, unknown>,
    context: { requestId: string; scanId: string },
    sandboxFailure?: string,
  ): Promise<LocalAnalyzerExecution> {
    if (sandboxFailure !== undefined) {
      return unavailableResult('custom-rule', this.dependencies.customRuleAnalyzer.version, context, sandboxFailure);
    }
    const availability = await this.dependencies.semgrepAvailability();
    if (!availability.available) {
      return unavailableResult('custom-rule', this.dependencies.customRuleAnalyzer.version,
        context, availability.reasonCode);
    }
    return this.runBudgeted(sampleId, 'custom-rule', () => this.dependencies.customRuleAnalyzer.analyzeResult(
      { extractedPath: packageRoot, packageJson }, context,
    ));
  }

  private async runBudgeted(
    sampleId: string,
    name: SmokeAnalyzerName,
    operation: () => AnalyzerResult | Promise<AnalyzerResult>,
  ): Promise<LocalAnalyzerExecution> {
    if (this.dependencies.invocationBudget) {
      if (!this.dependencies.invocationBackendAttestation) throw new Error('SMOKE_BACKEND_ATTESTATION_REQUIRED');
      await this.dependencies.invocationBudget.reserve(sampleId, name, this.dependencies.invocationBackendAttestation);
    }
    return this.run(name, operation);
  }

  private async run(name: string, operation: () => AnalyzerResult | Promise<AnalyzerResult>): Promise<LocalAnalyzerExecution> {
    const started = performance.now();
    try {
      const result = await operation();
      return {
        name,
        status: localStatus(result),
        result,
        durationMs: Math.max(0, performance.now() - started),
      };
    } catch {
      const result: AnalyzerResult = {
        requestId: '', scanId: '', analyzer: name, analyzerVersion: 'unknown',
        status: 'FAILED', findings: [], errors: [localFailure(name, 'ANALYZER_FAILED')],
      };
      return { name, status: 'FAILED', result, durationMs: Math.max(0, performance.now() - started) };
    }
  }
}

function localStatus(result: AnalyzerResult): LocalAnalyzerStatus {
  if (result.status === 'SUCCESS' || result.status === 'PARTIAL') return 'COMPLETED';
  if (result.status === 'TIMEOUT') return 'TIMEOUT';
  if (result.status === 'SKIPPED') return 'SKIPPED';
  return 'FAILED';
}

function unavailableResult(
  analyzer: string,
  analyzerVersion: string,
  context: { requestId: string; scanId: string },
  reasonCode: string,
): LocalAnalyzerExecution {
  const result: AnalyzerResult = {
    ...context,
    analyzer,
    analyzerVersion,
    status: 'SKIPPED',
    findings: [],
    errors: [localFailure(analyzer, reasonCode)],
  };
  return { name: analyzer, status: 'UNAVAILABLE', reasonCode, result, durationMs: 0 };
}

function localFailure(analyzer: string, message: string): ScanError {
  return { code: ScannerErrorCode.INTERNAL_ERROR, stage: `ANALYZER:${analyzer.toUpperCase()}`, analyzer, message, retryable: false };
}

function assertUniqueFindingIds(findings: Finding[]): void {
  const ids = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.findingId)) throw new Error(`DUPLICATE_FINDING_ID:${finding.findingId}`);
    ids.add(finding.findingId);
  }
}

function assertEvidenceSources(findings: Finding[], evidences: LocalStaticAnalysisResult['atomicEvidences']): void {
  const ids = new Set(findings.map(({ findingId }) => findingId));
  for (const evidence of evidences) {
    for (const source of evidence.sources) {
      if (!ids.has(source.rawFindingId)) throw new Error(`DANGLING_EVIDENCE_SOURCE:${source.rawFindingId}`);
    }
  }
}

function redactAnalyzerResult(result: AnalyzerResult, packageRoots: readonly string[]): AnalyzerResult {
  let text = JSON.stringify(result);
  for (const packageRoot of packageRoots) text = text.split(packageRoot).join('<PACKAGE_ROOT>');
  text = text.split('/analysis/package').join('<PACKAGE_ROOT>');
  return JSON.parse(text) as AnalyzerResult;
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(directory, entry.name);
      const name = relative(root, absolute);
      hash.update(name); hash.update('\0');
      if (entry.isSymbolicLink()) throw new Error('PACKAGE_ROOT_SYMLINK_NOT_ALLOWED');
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) { hash.update(await readFile(absolute)); hash.update('\0'); }
      else throw new Error('PACKAGE_ROOT_SPECIAL_FILE_NOT_ALLOWED');
    }
  }
  if (!(await stat(root)).isDirectory()) throw new Error('PACKAGE_ROOT_INVALID');
  await walk(root);
  return hash.digest('hex');
}
