import { Injectable, Logger, Optional } from '@nestjs/common';
import { join } from 'node:path';

import {
  type AnalysisContext,
  type AnalyzerResult,
  type PackageIdentity,
  type ScanError,
  type ScanResult,
  type ShadowAnalysisRecord,
} from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { EvidenceNormalizer } from '../../evidence/normalizer/evidence-normalizer';
import type {
  AtomicEvidenceV0_1,
  NormalizationResult,
} from '../../evidence/normalizer/evidence-normalizer.types';
import {
  CUSTOM_RULE_ANALYZER_VERSION,
  CustomRuleAnalyzer,
} from '../../analyzers/custom-rule/custom-rule.analyzer';
import {
  GUARDDOG_ANALYZER_VERSION,
  GuardDogAnalyzer,
} from '../../analyzers/guarddog/guarddog.analyzer';
import {
  decideGuardDogExecution,
  skippedGuardDogResult,
} from '../../analyzers/guarddog/guarddog-execution-policy';
import {
  METADATA_ANALYZER_VERSION,
  MetadataAnalyzer,
} from '../../analyzers/metadata/metadata.analyzer';
import { ArtifactHasher } from '../../artifact/hasher/artifact-hasher';
import { PackageIdentityVerifier } from '../../artifact/identity/package-identity-verifier';
import { TarballDownloader } from '../../artifact/downloader/tarball-downloader';
import { SafeExtractor } from '../../artifact/extractor/safe-extractor';
import { RegistryMetadataClient } from '../../registry/metadata-client/registry-metadata-client';
import {
  PackageDeadline,
  PackageDeadlineExceededError,
} from '../package-deadline';
import {
  ScannerPerformanceMeasurement,
  type ScannerPerformanceSnapshot,
} from '../../performance/scanner-performance';
import { withAnalyzerExecution } from '../../analyzers/analyzer.contract';
import { OsvFeedClient } from '../../osv/osv-feed-client';
import type { OsvFeedResult } from '../../osv/osv-feed.types';
import { OsvFeedCacheAdapter } from '../../osv/osv-feed-cache';
import { loadLlmAgentEnvironment } from '../../config/scanner-environment';
import { LlmAgentRunnerService } from '../../llm-agent/agent-runner.service';
import { LlmEvidenceAdapter, type LlmAssessmentEvidence } from '../../llm-agent/llm-evidence.adapter';
import type { AgentAnalysisSummary, AgentFailureReason } from '../../llm-agent/output.contract';
import { AgentInputV0_3Builder } from '../../llm-agent/artifact/agent-input-v0_3.builder';
import { summarizeContextCheck } from '../../llm-agent/context-check/context-check.service';
import { JevProviderClient } from '../../llm-agent/context-check/jev-provider.client';
import { executeTier3V0_3, skippedTier3Shadow, toTier3ShadowResult, type Tier3ShadowResult } from '../../llm-agent/artifact/tier3-runtime';
import {
  ObfuscationAnalyzer,
  OBFUSCATION_ANALYZER_VERSION,
  type ObfuscationShadowResult,
} from '../../analyzers/obfuscation/obfuscation.analyzer';
import { buildTier2ArtifactDescriptor } from '../../analyzers/obfuscation/tier2-handoff';
import { buildAgentPlanningInput } from '../planning/agent-planning-input.adapter';
import { evaluateStaticFilter } from '../planning/static-filter';
import type { StaticFilterResult } from '../planning/static-filter.types';
import { buildPlanningTier3ExecutionInput, type PlanningTier3RestoredArtifact, type RestoredArtifactUnavailableReason } from '../../llm-agent/artifact/planning-tier3-execution-input';

export interface ScanExecutionRequest {
  requestId: string;
  scanId: string;
  registryId: string;
  packageName: string;
  packageVersion: string;
  expectedIntegrity?: string | null;
}

export interface ScanExecutionResult<TEvidence = unknown> {
  scanResult: ScanResult<TEvidence>;
  osvFeed: OsvFeedResult;
  calculatedIntegrity?: string;
  policyEligible?: boolean;
  performance?: ScannerPerformanceSnapshot;
  agentAnalysisSummary?: AgentAnalysisSummary;
  agentFindingIds?: string[];
  /** Internal lineage only; it is not added to the public osvFeed contract. */
  feedSnapshotId?: string;
  /** Observation projected from the same V0.3 run; it never triggers a second run. */
  tier3Shadow?: Tier3ShadowResult;
  /** Internal Agent Planning decision used for routing; not part of ScanResult/API. */
  staticFilterResult?: StaticFilterResult;
}

@Injectable()
export class Orchestrator {
  private readonly logger = new Logger(Orchestrator.name);

  constructor(
    private readonly registryMetadataClient: RegistryMetadataClient,
    private readonly tarballDownloader: TarballDownloader,
    private readonly safeExtractor: SafeExtractor,
    private readonly artifactHasher: ArtifactHasher,
    private readonly packageIdentityVerifier: PackageIdentityVerifier,
    private readonly metadataAnalyzer: MetadataAnalyzer,
    private readonly customRuleAnalyzer: CustomRuleAnalyzer,
    private readonly guardDogAnalyzer: GuardDogAnalyzer,
    private readonly obfuscationAnalyzer: ObfuscationAnalyzer,
    private readonly evidenceNormalizer: EvidenceNormalizer,
    private readonly osvFeedClient: OsvFeedClient,
    @Optional() private readonly agentRunner?: LlmAgentRunnerService,
    @Optional() private readonly llmEvidenceAdapter?: LlmEvidenceAdapter,
    @Optional() private readonly osvFeedCacheAdapter?: OsvFeedCacheAdapter,
    @Optional() private readonly tier3InputBuilder?: AgentInputV0_3Builder,
    @Optional() private readonly contextCheckProvider?: JevProviderClient,
  ) {}

  async execute(
    request: ScanExecutionRequest,
    deadline: PackageDeadline,
  ): Promise<ScanExecutionResult<AtomicEvidenceV0_1 | LlmAssessmentEvidence>> {
    const performanceMeasurement = new ScannerPerformanceMeasurement();
    let stage: ScanError['stage'] = 'REGISTRY';
    let artifactHash = '';
    let calculatedIntegrity: string | undefined;
    let osvFeedPromise: Promise<OsvFeedResult> | undefined;
    let feedSnapshotId: string | undefined;
    let subject: PackageIdentity & { ecosystem: 'npm' } = {
      name: request.packageName,
      version: request.packageVersion,
      ecosystem: 'npm',
    };

    try {
      deadline.throwIfExpired();
      const registryMetadata = await performanceMeasurement.measureStage('REGISTRY', () =>
        this.registryMetadataClient.query({
          registryId: request.registryId,
          packageName: request.packageName,
          packageVersion: request.packageVersion,
        }, { signal: deadline.signal, timeoutMs: deadline.remainingMs() }));
      deadline.throwIfExpired();

      stage = 'DOWNLOAD';
      const downloaded = await performanceMeasurement.measureStage('DOWNLOAD', () =>
        this.tarballDownloader.download({
          scanId: request.scanId,
          tarballUrl: registryMetadata.tarballUrl,
          registryIntegrity: registryMetadata.registryIntegrity,
          expectedIntegrity: request.expectedIntegrity,
        }, { signal: deadline.signal, timeoutMs: deadline.remainingMs() }));
      calculatedIntegrity = downloaded.calculatedIntegrity;
      deadline.throwIfExpired();

      stage = 'EXTRACT';
      const extractedPath = join(downloaded.scanDir, 'extracted');
      await performanceMeasurement.measureStage('EXTRACT', () => this.safeExtractor.extract({
        artifactPath: downloaded.artifactPath,
        extractedPath,
        integrity: { verified: true },
      }));
      deadline.throwIfExpired();

      stage = 'HASH';
      artifactHash = await performanceMeasurement.measureStage('HASH', () =>
        this.artifactHasher.hash(downloaded.artifactPath));
      deadline.throwIfExpired();

      stage = 'IDENTITY';
      const packageJson = await performanceMeasurement.measureStage('IDENTITY', () =>
        this.packageIdentityVerifier.verify(extractedPath, subject));
      deadline.throwIfExpired();

      subject = {
        name: packageJson.name as string,
        version: packageJson.version as string,
        ecosystem: 'npm',
      };

      const context: Pick<AnalysisContext, 'requestId' | 'scanId'> = {
        requestId: request.requestId,
        scanId: request.scanId,
      };
      const analysisContext: AnalysisContext = {
        requestId: request.requestId,
        scanId: request.scanId,
        package: subject,
        artifact: {
          tarballPath: downloaded.artifactPath,
          extractedPath,
          hash: artifactHash,
          ...(request.expectedIntegrity === undefined
            ? {}
            : { expectedIntegrity: request.expectedIntegrity ?? undefined }),
          ...(registryMetadata.registryIntegrity === undefined
            ? {}
            : { registryIntegrity: registryMetadata.registryIntegrity }),
        },
        metadata: {
          registryMetadata: registryMetadata.registryMetadata,
          packageJson,
        },
      };

      stage = 'ANALYZER';
      const analyzerResultsPromise = performanceMeasurement.measureStage('ANALYZER', () =>
        this.runAnalyzers(analysisContext, context, deadline, performanceMeasurement));
      osvFeedPromise = this.queryOsvFeed({
        ecosystem: 'npm',
        packageName: subject.name,
        packageVersion: subject.version,
        permission: registryMetadata.registryId === 'npmjs'
          ? { allowed: true, basis: 'VERIFIED_PUBLIC_NPM' }
          : { allowed: false, reason: 'PROVENANCE_UNCONFIRMED' },
        remainingMs: deadline.expired ? 0 : deadline.remainingMs(),
        signal: deadline.signal,
      }, (snapshotId) => { feedSnapshotId = snapshotId; });
      const analyzerResults = await analyzerResultsPromise;
      if (deadline.expired) {
        return this.withPerformance({
          scanResult: this.toTimeoutResult(
            subject,
            artifactHash,
            analyzerResults,
            request,
          ),
          osvFeed: await osvFeedPromise,
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
          calculatedIntegrity,
          policyEligible: true,
        }, performanceMeasurement);
      }

      stage = 'OBFUSCATION';
      const obfuscation = await performanceMeasurement.measureStage(
        'OBFUSCATION',
        () => this.runObfuscationSafely(analysisContext, analyzerResults, deadline.signal),
      );
      const shadowAnalyzerResults = [
        obfuscation.analyzerResult,
        ...obfuscation.derivedAnalyzerResults,
      ];
      if (deadline.expired) {
        return this.withPerformance({
          scanResult: this.toTimeoutResult(
            subject,
            artifactHash,
            [...analyzerResults, ...shadowAnalyzerResults],
            request,
            [],
            [],
            [this.toObfuscationShadowRecord(obfuscation)],
          ),
          osvFeed: await osvFeedPromise,
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
          calculatedIntegrity,
          policyEligible: true,
        }, performanceMeasurement);
      }

      stage = 'NORMALIZATION';
      let normalizationResult: NormalizationResult;
      try {
        normalizationResult = await performanceMeasurement.measureStage('NORMALIZATION', () =>
          this.evidenceNormalizer.normalize({
            requestId: analysisContext.requestId,
            scanId: analysisContext.scanId,
            subject: {
              ecosystem: 'npm',
              packageName: analysisContext.package.name,
              packageVersion: analysisContext.package.version,
              artifactHash: analysisContext.artifact.hash,
            },
            artifactRoot: analysisContext.artifact.extractedPath,
            analyzerResults,
            ...(obfuscation.evidenceCandidates?.length === 0 || obfuscation.evidenceCandidates === undefined
              ? {}
              : { tier2Candidates: obfuscation.evidenceCandidates }),
          }));
      } catch (error) {
        if (deadline.expired) {
          return this.withPerformance({
            scanResult: this.toTimeoutResult(
              subject,
              artifactHash,
              [...analyzerResults, ...shadowAnalyzerResults],
              request,
              [],
              [],
              [this.toObfuscationShadowRecord(obfuscation)],
            ),
            osvFeed: await osvFeedPromise,
            calculatedIntegrity,
            policyEligible: true,
          }, performanceMeasurement);
        }
        return this.withPerformance({
          scanResult: this.normalizationFailureResult(
            subject,
            artifactHash,
            [...analyzerResults, ...shadowAnalyzerResults],
            request,
            this.toScanError(error, stage),
            [this.toObfuscationShadowRecord(obfuscation)],
          ),
          osvFeed: await osvFeedPromise,
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
          calculatedIntegrity: downloaded.calculatedIntegrity,
        }, performanceMeasurement);
      }
      const planningInput = buildAgentPlanningInput({
        context: analysisContext,
        tier1Results: analyzerResults,
        tier2Result: obfuscation,
        normalizationResult,
      });
      const staticFilterResult = evaluateStaticFilter(planningInput);
      const scanResult = this.toScanResult(
        subject,
        artifactHash,
        analyzerResults,
        normalizationResult,
        request,
        shadowAnalyzerResults,
        [this.toObfuscationShadowRecord(obfuscation)],
      );
      const agentSettings = loadLlmAgentEnvironment();
      let agentAnalysisSummary: AgentAnalysisSummary | undefined;
      let llmEvidences: LlmAssessmentEvidence[] = [];
      let agentFindingIds: string[] | undefined;
      let tier3Shadow: Tier3ShadowResult;
      const filterRequiresAgent = staticFilterResult.status === 'STATIC_INCOMPLETE'
        || staticFilterResult.status === 'AMBIGUOUS';
      if (!filterRequiresAgent) {
        const triggerReason = staticFilterResult.status === 'STATIC_MALICIOUS'
          ? 'STATIC_FILTER_MALICIOUS' : 'NO_THREAT_FINDING';
        agentAnalysisSummary = this.skippedAgentSummary(triggerReason, staticFilterResult.reasonCodes);
        tier3Shadow = skippedTier3Shadow(triggerReason, staticFilterResult.reasonCodes);
      } else if (!agentSettings.LLM_AGENT_ENABLED || agentSettings.LLM_AGENT_TRIGGER_MODE === 'DISABLED') {
        agentAnalysisSummary = this.skippedAgentSummary('AGENT_DISABLED');
        tier3Shadow = skippedTier3Shadow('AGENT_DISABLED');
      } else {
        let restoredArtifact: PlanningTier3RestoredArtifact | undefined;
        let restoredArtifactUnavailableReason: RestoredArtifactUnavailableReason | undefined;
        try {
          const originalContentSha256 = await this.artifactHasher.hashDirectory(analysisContext.artifact.extractedPath);
          if (obfuscation.restore !== undefined && obfuscation.restore.restored.length > 0) {
            try {
              const restoredHash = await this.artifactHasher.hashDirectory(obfuscation.restore.outputRoot);
              restoredArtifact = {
                descriptor: buildTier2ArtifactDescriptor(analysisContext, obfuscation.restore, restoredHash),
                root: obfuscation.restore.outputRoot,
              };
            } catch {
              restoredArtifactUnavailableReason = 'RESTORED_ARTIFACT_HASH_FAILED';
            }
          }
          const executionInput = buildPlanningTier3ExecutionInput({
            context: analysisContext,
            planningInput,
            originalContentSha256,
            ...(restoredArtifact === undefined ? {} : { restoredArtifact }),
            ...(restoredArtifactUnavailableReason === undefined ? {} : { restoredArtifactUnavailableReason }),
          });
          const operational = await executeTier3V0_3({
            execution: executionInput,
            context: {
              scanId: analysisContext.scanId,
              packageName: analysisContext.package.name,
              packageVersion: analysisContext.package.version,
              archiveSha256: analysisContext.artifact.hash,
            },
            settings: agentSettings,
            dependencies: {
              inputBuilder: this.tier3InputBuilder,
              runner: this.agentRunner,
              evidenceAdapter: this.llmEvidenceAdapter,
              contextCheckProvider: this.contextCheckProvider,
            },
            triggerReason: `STATIC_FILTER_${staticFilterResult.status}`,
            staticFilter: staticFilterResult,
            signal: deadline.signal,
          });
          llmEvidences = operational.evidences;
          agentAnalysisSummary = operational.summary;
          // Policy validates LLM Evidence references against the complete V0.3 input scope.
          // Assessed/cited IDs remain stricter observability subsets, not the allow-list.
          agentFindingIds = operational.inputFindingIds;
          tier3Shadow = toTier3ShadowResult(operational);
        } catch {
          const failureReason = deadline.expired ? 'TIMEOUT' : 'INPUT_BUILD_FAILED';
          agentAnalysisSummary = this.failedAgentSummary(failureReason, `STATIC_FILTER_${staticFilterResult.status}`);
          tier3Shadow = {
            ...skippedTier3Shadow(`STATIC_FILTER_${staticFilterResult.status}`, [failureReason]),
            status: deadline.expired ? 'TIMEOUT' : 'FAILED',
            summary: agentAnalysisSummary,
            failureReason,
          };
        }
      }
      this.logPlanningOutcome(request, staticFilterResult, agentAnalysisSummary);
      const scanResultWithTier3Observation: ScanResult<AtomicEvidenceV0_1> = {
        ...scanResult,
        shadowAnalyses: [
          ...(scanResult.shadowAnalyses ?? []),
          this.toTier3ShadowRecord(tier3Shadow),
        ],
      };
      if (deadline.expired) {
        return this.withPerformance({
          scanResult: this.toTimeoutResult(
            subject,
            artifactHash,
            analyzerResults,
            request,
            scanResultWithTier3Observation.evidences,
            scanResultWithTier3Observation.errors,
            scanResultWithTier3Observation.shadowAnalyses,
          ),
          osvFeed: await osvFeedPromise,
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
          calculatedIntegrity,
          policyEligible: true,
          agentAnalysisSummary,
          agentFindingIds,
          tier3Shadow,
          staticFilterResult,
        }, performanceMeasurement);
      }

      return this.withPerformance({
        scanResult: { ...scanResultWithTier3Observation, evidences: [...scanResultWithTier3Observation.evidences, ...llmEvidences] },
          osvFeed: await osvFeedPromise,
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
        calculatedIntegrity,
        policyEligible: true,
        agentAnalysisSummary,
        agentFindingIds,
        tier3Shadow,
        staticFilterResult,
      }, performanceMeasurement);
    } catch (error) {
      if (error instanceof PackageDeadlineExceededError || deadline.expired) {
        return this.withPerformance({
          scanResult: this.timeoutResult(subject, request, artifactHash),
          osvFeed: await this.resolveOsvFeed(osvFeedPromise, request, deadline, (snapshotId) => { feedSnapshotId = snapshotId; }),
          ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
          calculatedIntegrity,
          policyEligible: false,
        }, performanceMeasurement);
      }
      return this.withPerformance({
        scanResult: this.failureResult(
          subject,
          request,
          this.toScanError(error, stage),
        ),
        osvFeed: await this.resolveOsvFeed(osvFeedPromise, request, deadline, (snapshotId) => { feedSnapshotId = snapshotId; }),
        ...(feedSnapshotId === undefined ? {} : { feedSnapshotId }),
      }, performanceMeasurement);
    }
  }

  private resolveOsvFeed(
    osvFeedPromise: Promise<OsvFeedResult> | undefined,
    request: ScanExecutionRequest,
    deadline: PackageDeadline,
    onSnapshotId?: (snapshotId: string) => void,
  ): Promise<OsvFeedResult> {
    return osvFeedPromise ?? this.queryOsvFeed({
      ecosystem: 'npm',
      packageName: request.packageName,
      packageVersion: request.packageVersion,
      permission: { allowed: false, reason: 'PROVENANCE_UNCONFIRMED' },
      remainingMs: deadline.expired ? 0 : deadline.remainingMs(),
      signal: deadline.signal,
    }, onSnapshotId);
  }

  private async queryOsvFeed(
    input: Parameters<OsvFeedClient['query']>[0],
    onSnapshotId?: (snapshotId: string) => void,
  ): Promise<OsvFeedResult> {
    if (this.osvFeedCacheAdapter === undefined) return this.osvFeedClient.query(input);
    const resolution = await this.osvFeedCacheAdapter.query(input);
    // The ID is deliberately kept on ScanExecutionResult, not on the shared osvFeed JSON.
    if (resolution.snapshotId !== undefined) onSnapshotId?.(resolution.snapshotId);
    return resolution.feed;
  }

  private async runAnalyzers(
    context: AnalysisContext,
    analyzerContext: Pick<AnalysisContext, 'requestId' | 'scanId'>,
    deadline: PackageDeadline,
    performanceMeasurement: ScannerPerformanceMeasurement,
  ): Promise<AnalyzerResult[]> {
    const metadataResult = await this.runAnalyzerSafely(
      'metadata',
      METADATA_ANALYZER_VERSION,
      analyzerContext,
      performanceMeasurement,
      () => this.metadataAnalyzer.analyzeResult({
        registryMetadata: context.metadata.registryMetadata,
        packageJson: context.metadata.packageJson,
      }, analyzerContext, deadline.signal),
    );
    const customRuleResult = await this.runAnalyzerSafely(
      'custom-rule',
      CUSTOM_RULE_ANALYZER_VERSION,
      analyzerContext,
      performanceMeasurement,
      () => this.customRuleAnalyzer.analyzeResult({
        extractedPath: context.artifact.extractedPath,
        packageJson: context.metadata.packageJson,
      }, analyzerContext, deadline.signal),
    );
    const guardDogDecision = decideGuardDogExecution(metadataResult, customRuleResult);
    const guardDogResult = await this.runAnalyzerSafely(
      'guarddog',
      GUARDDOG_ANALYZER_VERSION,
      analyzerContext,
      performanceMeasurement,
      () => guardDogDecision.shouldRun
        ? this.guardDogAnalyzer.analyzeResult({ context }, analyzerContext, deadline.signal)
        : skippedGuardDogResult(analyzerContext, GUARDDOG_ANALYZER_VERSION),
    );

    return [metadataResult, customRuleResult, guardDogResult];
  }

  private async runObfuscationSafely(
    context: AnalysisContext,
    tier1Results: AnalyzerResult[],
    signal: AbortSignal,
  ): Promise<ObfuscationShadowResult> {
    try {
      return await this.obfuscationAnalyzer.analyze(context, tier1Results, signal);
    } catch {
      return {
        analyzerResult: {
          requestId: context.requestId,
          scanId: context.scanId,
          analyzer: 'obfuscation',
          analyzerVersion: OBFUSCATION_ANALYZER_VERSION,
          status: 'FAILED',
          findings: [],
          errors: [{
            code: ScannerErrorCode.INTERNAL_ERROR,
            stage: 'ANALYZER:OBFUSCATION',
            analyzer: 'obfuscation',
            message: 'obfuscation Analyzer failed unexpectedly',
            retryable: false,
          }],
        },
        derivedAnalyzerResults: [],
        evidenceCandidates: [],
        planningInput: {
          kind: 'TIER2_RESTORE_PROJECTION',
          requestId: context.requestId,
          scanId: context.scanId,
          artifactHash: context.artifact.hash,
          restoreFiles: [],
          evidenceCandidates: [],
        },
        summary: {
          gptMode: 'off',
          scannedFiles: 0,
          selectedFiles: 0,
          restoredFiles: 0,
          partialRestoredFiles: 0,
          unresolvedFiles: 0,
          newRuleIds: [],
          derivedAnalyzerStatuses: [],
          evidenceBundles: [],
          gpt: {
            status: 'FAILED',
            durationMs: 0,
            reason: '난독화 Shadow 분석이 실패했습니다.',
          },
        },
      };
    }
  }

  private skippedAgentSummary(triggerReason: string, limitations: readonly string[] = []): AgentAnalysisSummary {
    return {
      status: 'SKIPPED', assessmentCount: 0, verifiedAssessmentCount: 0,
      generatedEvidenceCount: 0, rejectedAssessmentCount: 0,
      limitations: [...new Set(limitations)], triggerReason,
    };
  }

  private failedAgentSummary(failureReason: AgentFailureReason, triggerReason: string): AgentAnalysisSummary {
    return {
      status: failureReason === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', assessmentCount: 0,
      verifiedAssessmentCount: 0, generatedEvidenceCount: 0, rejectedAssessmentCount: 0,
      limitations: [failureReason], failureReason, triggerReason,
    };
  }

  private logPlanningOutcome(
    request: ScanExecutionRequest,
    filter: StaticFilterResult,
    summary: AgentAnalysisSummary,
  ): void {
    this.logger.log(JSON.stringify({
      event: 'AGENT_PLANNING_STATIC_FILTER', requestId: request.requestId, scanId: request.scanId,
      filterStatus: filter.status, ruleVersion: filter.ruleVersion, reasonCodes: filter.reasonCodes,
      agentStatus: summary.status, agentTriggerReason: summary.triggerReason,
      generatedEvidenceCount: summary.generatedEvidenceCount,
      ...(summary.failureReason === undefined ? {} : { failureReason: summary.failureReason }),
    }));
  }

  private toTimeoutResult(
    subject: PackageIdentity & { ecosystem: 'npm' },
    artifactHash: string,
    analyzerResults: AnalyzerResult[],
    request: ScanExecutionRequest,
    evidences: AtomicEvidenceV0_1[] = [],
    existingErrors: ScanError[] = [],
    shadowAnalyses?: ShadowAnalysisRecord[],
  ): ScanResult<AtomicEvidenceV0_1> {
    return {
      schemaVersion: '0.1',
      requestId: request.requestId,
      scanId: request.scanId,
      subject,
      artifactHash,
      status: 'TIMEOUT',
      evidences,
      analyzerSummaries: this.toAnalyzerSummaries(analyzerResults),
      ...(shadowAnalyses === undefined ? {} : { shadowAnalyses }),
      errors: [{
        code: ScannerErrorCode.INTERNAL_ERROR,
        stage: 'PACKAGE_TIMEOUT',
        message: 'Scanner package analysis deadline exceeded',
        retryable: true,
      }, ...existingErrors, ...analyzerResults.flatMap(({ errors }) => errors)],
    };
  }

  private timeoutResult(
    subject: PackageIdentity & { ecosystem: 'npm' },
    request: ScanExecutionRequest,
    artifactHash = '',
  ): ScanResult<AtomicEvidenceV0_1> {
    return this.toTimeoutResult(subject, artifactHash, [], request);
  }

  private async runAnalyzerSafely(
    analyzer: string,
    analyzerVersion: string,
    context: Pick<AnalysisContext, 'requestId' | 'scanId'>,
    performanceMeasurement: ScannerPerformanceMeasurement,
    run: () => AnalyzerResult | Promise<AnalyzerResult>,
  ): Promise<AnalyzerResult> {
    const startedAt = new Date().toISOString();
    const startedAtClock = performance.now();
    try {
      const result = await performanceMeasurement.measureAnalyzer(analyzer, run);
      const completedAt = new Date().toISOString();
      return withAnalyzerExecution(
        result,
        startedAt,
        completedAt,
        performance.now() - startedAtClock,
      );
    } catch {
      const completedAt = new Date().toISOString();
      return {
        requestId: context.requestId,
        scanId: context.scanId,
        analyzer,
        analyzerVersion,
        status: 'FAILED',
        findings: [],
        errors: [{
          code: ScannerErrorCode.INTERNAL_ERROR,
          stage: `ANALYZER:${analyzer.toUpperCase()}`,
          analyzer,
          message: `${analyzer} Analyzer failed unexpectedly`,
          retryable: false,
          }],
        execution: {
          startedAt,
          completedAt,
          durationMs: Math.max(0, performance.now() - startedAtClock),
        },
      };
    }
  }

  private withPerformance(
    result: Omit<ScanExecutionResult<AtomicEvidenceV0_1 | LlmAssessmentEvidence>, 'performance'>,
    performanceMeasurement: ScannerPerformanceMeasurement,
  ): ScanExecutionResult<AtomicEvidenceV0_1 | LlmAssessmentEvidence> {
    return {
      ...result,
      performance: performanceMeasurement.finish(),
    };
  }

  private toScanResult(
    subject: PackageIdentity & { ecosystem: 'npm' },
    artifactHash: string,
    analyzerResults: AnalyzerResult[],
    normalizationResult: NormalizationResult,
    request: ScanExecutionRequest,
    shadowAnalyzerResults: AnalyzerResult[] = [],
    shadowAnalyses?: ShadowAnalysisRecord[],
  ): ScanResult<AtomicEvidenceV0_1> {
    const errors = [
      ...analyzerResults.flatMap((result) => result.errors),
      ...normalizationResult.errors,
      ...this.toUnmappedSummaryErrors(normalizationResult),
    ];

    return {
      schemaVersion: '0.1',
      requestId: request.requestId,
      scanId: request.scanId,
      subject,
      artifactHash,
      status: this.toScanStatus(analyzerResults, normalizationResult),
      evidences: normalizationResult.atomicEvidences,
      analyzerSummaries: this.toAnalyzerSummaries([
        ...analyzerResults,
        ...shadowAnalyzerResults,
      ]),
      ...(shadowAnalyses === undefined ? {} : { shadowAnalyses }),
      errors,
    };
  }

  private toScanStatus(
    analyzerResults: AnalyzerResult[],
    normalizationResult: NormalizationResult,
  ): ScanResult<AtomicEvidenceV0_1>['status'] {
    if (analyzerResults.some(({ status }) => status === 'TIMEOUT')) return 'TIMEOUT';
    if (analyzerResults.some(({ status }) => status === 'FAILED')) return 'FAILED';
    if (analyzerResults.some(({ status }) => status === 'PARTIAL')) return 'PARTIAL';
    if (
      normalizationResult.unmappedFindings.length > 0 ||
      normalizationResult.errors.length > 0
    ) {
      return 'PARTIAL';
    }
    return 'COMPLETED';
  }

  private normalizationFailureResult(
    subject: PackageIdentity & { ecosystem: 'npm' },
    artifactHash: string,
    analyzerResults: AnalyzerResult[],
    request: ScanExecutionRequest,
    error: ScanError,
    shadowAnalyses?: ShadowAnalysisRecord[],
  ): ScanResult<AtomicEvidenceV0_1> {
    return {
      schemaVersion: '0.1',
      requestId: request.requestId,
      scanId: request.scanId,
      subject,
      artifactHash,
      status: 'FAILED',
      evidences: [],
      analyzerSummaries: this.toAnalyzerSummaries(analyzerResults),
      ...(shadowAnalyses === undefined ? {} : { shadowAnalyses }),
      errors: [
        ...analyzerResults.flatMap((result) => result.errors),
        error,
      ],
    };
  }

  private toAnalyzerSummaries(
    analyzerResults: AnalyzerResult[],
  ): ScanResult['analyzerSummaries'] {
    return analyzerResults.map((result) => ({
      name: result.analyzer,
      version: result.analyzerVersion,
      status: result.status,
      findingCount: result.findings.length,
      errorCount: result.errors.length,
    }));
  }

  private toObfuscationShadowRecord(
    result: ObfuscationShadowResult,
  ): ShadowAnalysisRecord {
    return {
      analyzer: 'obfuscation',
      analyzerVersion: OBFUSCATION_ANALYZER_VERSION,
      mode: 'SHADOW',
      data: result.summary,
    };
  }

  private toTier3ShadowRecord(
    result: Tier3ShadowResult,
  ): ShadowAnalysisRecord {
    return {
      analyzer: 'tier3-agent-v0.3',
      analyzerVersion: '0.3.0',
      mode: 'SHADOW',
      data: {
        status: result.status,
        triggerReason: result.triggerReason,
        generatedEvidenceCount: result.generatedEvidenceCount,
        conversionFailureCount: result.conversionFailures.length,
        initialSliceCount: result.initialSliceCount,
        runtimeSliceCount: result.runtimeSliceCount,
        codeRequests: result.codeRequests,
        limitations: result.limitations,
        ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
        ...(result.contextCheck === undefined ? {} : { contextCheck: summarizeContextCheck(result.contextCheck) }),
      },
    };
  }

  private toUnmappedSummaryErrors(
    normalizationResult: NormalizationResult,
  ): ScanError[] {
    const unmappedCount = normalizationResult.unmappedFindings.length;
    if (unmappedCount === 0) return [];

    return [
      {
        code: ScannerErrorCode.INTERNAL_ERROR,
        stage: 'NORMALIZATION:UNMAPPED_FINDINGS',
        message: `${unmappedCount} Finding(s) could not be normalized to Evidence`,
        retryable: false,
      },
    ];
  }

  private failureResult(
    subject: PackageIdentity & { ecosystem: 'npm' },
    request: ScanExecutionRequest,
    error: ScanError,
  ): ScanResult<AtomicEvidenceV0_1> {
    return {
      schemaVersion: '0.1',
      requestId: request.requestId,
      scanId: request.scanId,
      subject,
      artifactHash: '',
      status: 'FAILED',
      evidences: [],
      analyzerSummaries: [],
      errors: [error],
    };
  }

  private toScanError(error: unknown, fallbackStage = 'APPLICATION'): ScanError {
    if (isScannerError(error)) {
      return {
        code: error.code,
        stage: typeof error.stage === 'string' ? error.stage : fallbackStage,
        ...(typeof error.analyzer === 'string' ? { analyzer: error.analyzer } : {}),
        message: error.message,
        retryable: typeof error.retryable === 'boolean' ? error.retryable : false,
      };
    }

    return {
      code: ScannerErrorCode.INTERNAL_ERROR,
      stage: fallbackStage,
      message: error instanceof Error ? error.message : 'Scanner execution failed',
      retryable: false,
    };
  }
}

interface ScannerErrorLike {
  code: ScannerErrorCode;
  message: string;
  stage?: string;
  analyzer?: string;
  retryable?: boolean;
}

function isScannerError(error: unknown): error is ScannerErrorLike {
  if (error === null || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return typeof value.message === 'string'
    && isScannerErrorCode(value.code);
}

function isScannerErrorCode(value: unknown): value is ScannerErrorCode {
  return typeof value === 'string'
    && Object.values(ScannerErrorCode).includes(value as ScannerErrorCode);
}
