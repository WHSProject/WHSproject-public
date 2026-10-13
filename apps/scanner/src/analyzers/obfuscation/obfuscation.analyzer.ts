import { Injectable } from '@nestjs/common';
import { dirname, join } from 'node:path';

import type {
  AnalysisContext,
  AnalyzerResult,
  Finding,
} from '../../domain/analysis.types';
import { ScannerErrorCode } from '../../domain/scanner-error-code';
import { CustomRuleAnalyzer } from '../custom-rule/custom-rule.analyzer';
import { GuardDogAnalyzer } from '../guarddog/guarddog.analyzer';
import { buildAgentAnalysisRequest } from './agent-analysis-request';
import type {
  CodeUnderstandingAssistant,
  ObfuscationGptMode,
  ObfuscationShadowData,
} from './agent-analysis.types';
import type { Tier2PlanningInput } from '../../application/planning/tier2-planning-input.types';
import {
  buildFileEvidenceBundles,
  selectGptCandidates,
} from './evidence-bundle';
import {
  collectTier2EvidenceCandidates,
  type Tier2EvidenceCandidate,
} from './evidence-candidate-gate';
import { buildTier2PlanningInput } from './tier2-planning-input';
import { buildObfuscationFindings } from './obfuscation.findings';
import { DEFAULT_BUDGET } from './obfuscation.types';
import { runRestorePipeline } from './restore.pipeline';
import { buildCandidateContext, selectTargets } from './target-selector';
import type { RestoreResult } from './obfuscation.types';
import { attachCapabilityPreservation } from './capability-preservation';

export const OBFUSCATION_ANALYZER_VERSION = '0.2.0';

export interface ObfuscationShadowResult {
  analyzerResult: AnalyzerResult;
  derivedAnalyzerResults: AnalyzerResult[];
  evidenceCandidates: Tier2EvidenceCandidate[];
  planningInput: Tier2PlanningInput;
  summary: ObfuscationShadowData;
  /** Available to the internal Tier 2 -> Tier 3 handoff only. */
  restore?: RestoreResult;
}

@Injectable()
export class ObfuscationAnalyzer {
  constructor(
    private readonly customRuleAnalyzer: CustomRuleAnalyzer,
    private readonly guardDogAnalyzer: GuardDogAnalyzer,
    private readonly gptMode: ObfuscationGptMode = 'off',
    private readonly codeUnderstandingAssistant?: CodeUnderstandingAssistant,
  ) {}

  async analyze(
    context: AnalysisContext,
    tier1Results: AnalyzerResult[],
    signal?: AbortSignal,
  ): Promise<ObfuscationShadowResult> {
    const selection = await selectTargets(
      context.artifact.extractedPath,
      context.metadata.packageJson,
      DEFAULT_BUDGET,
      buildCandidateContext(tier1Results),
    );
    const outputRoot = join(
      dirname(context.artifact.extractedPath),
      'derived',
      'obfuscation',
    );
    const restore = await runRestorePipeline({
      extractedPath: context.artifact.extractedPath,
      outputRoot,
      targets: selection.targets,
      budget: DEFAULT_BUDGET,
      ...(signal === undefined ? {} : { signal }),
    });
    const derivedAnalyzerResults = restore.restored.length === 0
      ? []
      : await this.reanalyzeDerived(context, outputRoot, signal);
    const effectiveRestore = attachCapabilityPreservation(
      restore,
      tier1Results,
      derivedAnalyzerResults,
    );
    const findings = buildObfuscationFindings(selection, effectiveRestore, context.artifact.hash);
    const analyzerResult: AnalyzerResult = {
      requestId: context.requestId,
      scanId: context.scanId,
      analyzer: 'obfuscation',
      analyzerVersion: OBFUSCATION_ANALYZER_VERSION,
      status: this.toStatus(selection.scanLimitHit, effectiveRestore.unresolved.length),
      findings,
      errors: [],
    };
    const evidenceCandidates = await collectTier2EvidenceCandidates(
      derivedAnalyzerResults,
      effectiveRestore,
      {
        requestId: context.requestId,
        scanId: context.scanId,
        artifactHash: context.artifact.hash,
      },
    );
    const originalRuleIds = new Set(
      tier1Results.flatMap((result) => result.findings.map((finding) => finding.ruleId)),
    );
    const newRuleIds = [...new Set(
      derivedAnalyzerResults
        .flatMap((result) => result.findings.map((finding) => finding.ruleId))
        .filter((ruleId) => !originalRuleIds.has(ruleId)),
    )].sort();
    const evidenceBundles = buildFileEvidenceBundles(
      tier1Results,
      analyzerResult,
      derivedAnalyzerResults,
      effectiveRestore,
    );
    const planningInput = buildTier2PlanningInput(
      context,
      effectiveRestore,
      evidenceCandidates,
      evidenceBundles,
    );
    const gptCandidates = selectGptCandidates(
      evidenceBundles,
      effectiveRestore,
      context.artifact.extractedPath,
    );
    const agentAnalysisRequest = await buildAgentAnalysisRequest(
      context,
      gptCandidates,
      effectiveRestore,
    );
    const gpt = this.gptMode === 'off'
      ? { status: 'NOT_REQUESTED' as const, durationMs: 0 }
      : agentAnalysisRequest === undefined
        ? { status: 'NO_CANDIDATE' as const, durationMs: 0 }
        : this.codeUnderstandingAssistant === undefined
          ? {
              status: 'FAILED' as const,
              durationMs: 0,
              reason: 'LLM Shadow 클라이언트가 설정되지 않았습니다.',
            }
          : await this.codeUnderstandingAssistant.analyze(agentAnalysisRequest, signal);

    return {
      analyzerResult,
      derivedAnalyzerResults,
      evidenceCandidates,
      planningInput,
      restore: effectiveRestore,
      summary: {
        gptMode: this.gptMode,
        scannedFiles: selection.scannedFiles,
        selectedFiles: selection.targets.length,
        restoredFiles: effectiveRestore.restored.filter((file) => file.status === 'RESTORED').length,
        partialRestoredFiles: effectiveRestore.restored
          .filter((file) => file.status === 'PARTIAL_RESTORED').length,
        unresolvedFiles: effectiveRestore.unresolved.length,
        newRuleIds,
        derivedAnalyzerStatuses: derivedAnalyzerResults.map((result) => ({
          analyzer: result.analyzer,
          status: result.status,
          findingCount: result.findings.length,
        })),
        evidenceBundles,
        capabilityPreservation: effectiveRestore.capabilityPreservation,
        ...(agentAnalysisRequest === undefined ? {} : { agentAnalysisRequest }),
        gpt,
      },
    };
  }

  private toStatus(
    scanLimitHit: boolean,
    unresolvedCount: number,
  ): AnalyzerResult['status'] {
    return scanLimitHit || unresolvedCount > 0 ? 'PARTIAL' : 'SUCCESS';
  }

  private async reanalyzeDerived(
    context: AnalysisContext,
    outputRoot: string,
    signal?: AbortSignal,
  ): Promise<AnalyzerResult[]> {
    const analyzerContext = {
      requestId: context.requestId,
      scanId: context.scanId,
    };
    const derivedContext: AnalysisContext = {
      ...context,
      artifact: {
        ...context.artifact,
        extractedPath: outputRoot,
      },
    };

    const [customRule, guardDog] = await Promise.all([
      this.safeDerivedRun(
        'custom-rule-deobfuscated',
        this.customRuleAnalyzer.version,
        context,
        async () => this.customRuleAnalyzer.analyzeResult({
          extractedPath: outputRoot,
          packageJson: context.metadata.packageJson,
        }, analyzerContext, signal),
      ),
      this.safeDerivedRun(
        'guarddog-deobfuscated',
        this.guardDogAnalyzer.version,
        context,
        async () => this.guardDogAnalyzer.analyzeResult(
          { context: derivedContext },
          analyzerContext,
          signal,
        ),
      ),
    ]);

    return [customRule, guardDog];
  }

  private async safeDerivedRun(
    analyzer: string,
    analyzerVersion: string,
    context: AnalysisContext,
    run: () => Promise<AnalyzerResult>,
  ): Promise<AnalyzerResult> {
    try {
      const result = await run();
      return this.tagDerived(result, analyzer);
    } catch {
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
      };
    }
  }

  private tagDerived(result: AnalyzerResult, analyzer: string): AnalyzerResult {
    return {
      ...result,
      analyzer,
      findings: result.findings.map((finding): Finding => ({
        ...finding,
        findingId: finding.findingId.replace(/^[^:]+:/u, `${analyzer}:`),
        data: {
          ...finding.data,
          origin: 'DEOBFUSCATED',
          doesNotProve: '복원 도구가 만든 파생 코드에서 탐지된 정적 신호이며, '
            + '원본 실행 행위를 직접 증명하지 않는다.',
        },
      })),
    };
  }
}
