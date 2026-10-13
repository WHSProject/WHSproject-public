import { Injectable, Logger } from '@nestjs/common';

import { AnalyzedArtifactRegistry } from '../cache/analyzed-artifact.registry';
import { ApprovalClient } from '../clients/approval.client';
import { ScannerClient } from '../clients/scanner.client';
import { isScannerEnabled } from '../config/scanner.config';
import { PackageNotAllowedError } from '../errors/approval.errors';
import type { ArtifactIdentity } from '../types/artifact.types';
import type { DependencyResolutionResult } from '../types/dependency-tree.types';
import type { DecisionLookupBatch } from '../types/decision-lookup.types';
import {
  DecisionLookupStatus,
  type Decision,
} from '../types/decision.types';
import { DecisionHandlerService } from './decision-handler.service';
import { DecisionLookupService } from './decision-lookup.service';
import { DependencyTreeService } from './dependency-tree.service';
import { InstallDependencyHistoryService } from './install-dependency-history.service';
import { RootInstallIntentService } from './root-install-intent.service';

export interface TarballAnalysisResult {
  decision: Decision | null;
  decisionId: string | null;
  isRoot: boolean;
}

// tarball 요청의 분석·판정 확인·승인 등록을 담당한다.
// HTTP 요청·응답 객체는 다루지 않는다.
@Injectable()
export class TarballAnalysisService {
  private readonly logger = new Logger(TarballAnalysisService.name);

  constructor(
    private readonly dependencyTreeService: DependencyTreeService,
    private readonly decisionLookupService: DecisionLookupService,
    private readonly decisionHandlerService: DecisionHandlerService,
    private readonly scannerClient: ScannerClient,
    private readonly approvalClient: ApprovalClient,
    private readonly analyzedArtifactRegistry: AnalyzedArtifactRegistry,
    private readonly installDependencyHistoryService: InstallDependencyHistoryService,
    private readonly rootInstallIntentService: RootInstallIntentService,
  ) {}

  // 캐시를 확인하여 재검증 또는 새 분석을 선택한다.
  async analyze(
    requestId: string,
    packageName: string,
    version: string,
  ): Promise<TarballAnalysisResult> {
    // install intent는 tarball 분석 진입 시 최초 매칭 1회만 소비한다.
    const isRoot = this.rootInstallIntentService.consume(packageName);

    // Root 요청은 과거 설치 이력을 남겨야 하므로 cache HIT 여부와 관계없이
    // Arborist dependency closure를 확보한다.
    // 기존 tarball별 requestId는 변경하지 않고 Root requestId를 history key로 쓴다.
    if (isRoot) {
      return this.analyzedArtifactRegistry.runExclusive(async () => {
        const resolution =
          await this.dependencyTreeService.resolveForVersion(
            requestId,
            packageName,
            version,
          );

        await this.installDependencyHistoryService.record({
          rootRequestId: requestId,
          root: resolution.root,
          artifacts: resolution.artifacts,
        });

        const knownRoot = this.analyzedArtifactRegistry.recall(
          packageName,
          version,
        );

        if (knownRoot) {
          return this.reverify(requestId, knownRoot, true);
        }

        return this.runAnalysis(
          requestId,
          packageName,
          version,
          true,
          resolution,
        );
      });
    }

    const known = this.analyzedArtifactRegistry.recall(packageName, version);

    if (known) {
      return this.reverify(requestId, known, isRoot);
    }

    let analysisResult: TarballAnalysisResult | null = null;

    // 캐시에 없는 요청의 분석은 기존 대기열을 통해 순서대로 처리한다.
    const resolved = await this.analyzedArtifactRegistry.runExclusive(
      async () => {
        // 기다리는 동안 앞선 요청이 분석했을 수 있으므로 다시 확인한다.
        const recalled = this.analyzedArtifactRegistry.recall(
          packageName,
          version,
        );

        if (recalled) {
          return recalled;
        }

        analysisResult = await this.runAnalysis(
          requestId,
          packageName,
          version,
          isRoot,
        );

        return undefined;
      },
    );

    if (resolved) {
      return this.reverify(requestId, resolved, isRoot);
    }

    return analysisResult ?? {
      decision: null,
      decisionId: null,
      isRoot,
    };
  }

  // 트리 구성은 생략하지만, 현재 판정은 다시 확인한다.
  private async reverify(
    requestId: string,
    artifact: ArtifactIdentity,
    isRoot: boolean,
  ): Promise<TarballAnalysisResult> {
    const batch = await this.decisionLookupService.lookup({
      requestId,
      root: artifact,
      artifacts: [artifact],
    });

    this.logger.log(
      `requestId=${requestId} `
      + `${artifact.packageName}@${artifact.version} reverified `
      + '(tree build skipped)',
    );

    try {
      return await this.enforce(
        requestId,
        batch,
        artifact.packageName,
        artifact.version,
        isRoot,
      );
    } catch (error) {
      // 집행에 실패하면 기억을 지워 다음 요청에서 트리를 다시 확인한다.
      this.analyzedArtifactRegistry.forget(
        artifact.packageName,
        artifact.version,
      );

      throw error;
    }
  }

  // 의존성 트리를 구성하고 판정을 조회한 뒤 필요한 분석과 집행을 진행한다.
  private async runAnalysis(
    requestId: string,
    packageName: string,
    version: string,
    isRoot: boolean,
    resolutionOverride?: DependencyResolutionResult,
  ): Promise<TarballAnalysisResult> {
    const resolution =
      resolutionOverride
      ?? await this.dependencyTreeService.resolveForVersion(
        requestId,
        packageName,
        version,
      );

    const batch = await this.decisionLookupService.lookup(resolution);

    const routing =
      this.decisionHandlerService.classifyAndCreateScannerRequests(batch);

    this.logger.log(
      `requestId=${requestId} ${packageName}@${version} `
      + `artifacts=${resolution.artifacts.length} `
      + `hits=${routing.hits.length} `
      + `scannerTargets=${routing.scannerTargets.length}`,
    );

    // 모든 대상에 기존 판정이 있으면 바로 집행한다.
    if (routing.scannerRequest === null) {
      return this.enforce(
        requestId,
        batch,
        packageName,
        version,
        isRoot,
      );
    }

    // 꺼져 있으면 미판정 Package는 분석·집행 없이 통과한다.
    if (!isScannerEnabled()) {
      this.logger.warn(
        `requestId=${requestId} scan skipped (SCANNER_ENABLED=false) `
        + `packages=${routing.scannerRequest.packages.length}`,
      );

      return {
        ...this.findRequestedDecision(batch, packageName, version),
        isRoot,
      };
    }

    try {
      await this.scannerClient.scan(routing.scannerRequest);
    } catch (error) {
      // Scanner may persist a fail-closed Policy Decision before returning a
      // non-2xx response (for example when analysis coverage is incomplete).
      // Re-read the Decision DB once so that Gateway records and enforces that
      // authoritative Decision instead of losing Root/Decision context as a
      // generic HTTP 500. If any target is still missing, preserve the Scanner
      // failure and do not infer a Decision.
      let fallbackBatch: DecisionLookupBatch;
      try {
        fallbackBatch = await this.decisionLookupService.lookup(resolution);
      } catch {
        throw error;
      }
      const fallbackRouting =
        this.decisionHandlerService.classifyAndCreateScannerRequests(fallbackBatch);

      if (fallbackRouting.scannerTargets.length > 0) {
        throw error;
      }

      this.logger.warn(
        `requestId=${requestId} scanner request failed after Decisions were stored; `
        + `enforcing persisted Decisions packages=${fallbackBatch.results.length}`,
      );

      return this.enforce(
        requestId,
        fallbackBatch,
        packageName,
        version,
        isRoot,
      );
    }

    this.logger.log(
      `requestId=${requestId} scan completed `
      + `packages=${routing.scannerRequest.packages.length}`,
    );

    // 같은 분석 대상을 기준으로 판정을 다시 조회한다.
    const rebatch = await this.decisionLookupService.lookup(resolution);

    return this.enforce(
      requestId,
      rebatch,
      packageName,
      version,
      isRoot,
    );
  }

  // 판정에 따라 차단하거나 Verdaccio 승인 목록에 등록한다.
  private async enforce(
    requestId: string,
    batch: DecisionLookupBatch,
    packageName: string,
    version: string,
    isRoot: boolean,
  ): Promise<TarballAnalysisResult> {
    const decisionMeta =
      this.findRequestedDecision(batch, packageName, version);

    const enforcement =
      this.decisionHandlerService.evaluateEnforcement(batch);

    if (!enforcement.allowed) {
      const reasons = enforcement.blocked.map(
        ({ artifact, reason }) =>
          `${artifact.packageName}@${artifact.version}=${reason}`,
      );

      this.logger.warn(
        `requestId=${requestId} blocked `
        + `count=${enforcement.blocked.length} `
        + `reasons=${reasons.join(',')}`,
      );

      throw new PackageNotAllowedError(
        reasons,
        decisionMeta.decision,
        decisionMeta.decisionId,
        isRoot,
      );
    }

    // 승인 등록이 성공한 뒤에만 캐시에 기억한다.
    await this.approvalClient.register(enforcement.approvalRequest!);

    this.analyzedArtifactRegistry.remember(
      enforcement.approvalRequest!.packages,
    );

    this.logger.log(
      `requestId=${requestId} approved `
      + `packages=${enforcement.approvalRequest!.packages.length}`,
    );

    return {
      ...decisionMeta,
      isRoot,
    };
  }

  // download_events의 decision은 전체 dependency 중 임의 값이 아니라
  // 현재 tarball 요청 Package 자신의 최종 Decision을 기록한다.
  private findRequestedDecision(
    batch: DecisionLookupBatch,
    packageName: string,
    version: string,
  ): Pick<TarballAnalysisResult, 'decision' | 'decisionId'> {
    const requested = batch.results.find(
      ({ artifact }) =>
        artifact.packageName === packageName
        && artifact.version === version,
    );

    if (
      !requested
      || requested.lookupStatus === DecisionLookupStatus.NOT_FOUND
    ) {
      return {
        decision: null,
        decisionId: null,
      };
    }

    return {
      decision: requested.decision.decision,
      decisionId: requested.decision.decisionId,
    };
  }

}
