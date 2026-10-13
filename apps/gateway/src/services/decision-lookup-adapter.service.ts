import { Injectable } from '@nestjs/common';

import { DecisionLookupInvalidResponseError } from '../errors/decision-lookup.errors';
import type { ArtifactIdentity } from '../types/artifact.types';
import type {
  DecisionLookupBatch,
  DecisionLookupResult,
} from '../types/decision-lookup.types';
import {
  Decision,
  DecisionLookupStatus,
  type DecisionRecord,
} from '../types/decision.types';

const DECISION_VALUES = new Set<string>(Object.values(Decision));

@Injectable()
export class DecisionLookupAdapterService {
  // 조회 응답을 Gateway 내부 계약인 DecisionLookupBatch로 변환한다.
  //
  // 요청에 보낸 Artifact 목록을 함께 받아, 응답이 요청과 일대일로 대응하는지
  // 확인한다. Package가 누락되면 그 Package는 검사도 차단도 되지 않은 채
  // 조용히 사라지므로 반드시 오류로 처리한다.
  adapt(
    requestId: string,
    requestedArtifacts: ArtifactIdentity[],
    response: unknown,
  ): DecisionLookupBatch {
    if (!this.isRecord(response)) {
      throw new DecisionLookupInvalidResponseError('response must be an object');
    }

    // 다른 요청의 응답을 받으면 엉뚱한 요청의 판정을 적용하게 된다
    if (response.requestId !== undefined
      && response.requestId !== requestId) {
      throw new DecisionLookupInvalidResponseError(
        `expected requestId "${requestId}", `
        + `received "${String(response.requestId)}"`,
      );
    }

    const rawResults: unknown = response.results;

    if (!Array.isArray(rawResults)) {
      throw new DecisionLookupInvalidResponseError('results must be an array');
    }

    if (rawResults.length !== requestedArtifacts.length) {
      throw new DecisionLookupInvalidResponseError(
        `results length ${rawResults.length} does not match `
        + `the requested ${requestedArtifacts.length}`,
      );
    }

    const results = requestedArtifacts.map((artifact, index) =>
      this.adaptResult(artifact, rawResults[index]));

    return {
      requestId,
      results,
    };
  }

  private adaptResult(
    artifact: ArtifactIdentity,
    rawResult: unknown,
  ): DecisionLookupResult {
    if (!this.isRecord(rawResult)) {
      throw new DecisionLookupInvalidResponseError(
        `result for "${this.describe(artifact)}" must be an object`,
      );
    }

    this.assertIdentityMatches(artifact, rawResult);

    const { lookupStatus } = rawResult;

    if (lookupStatus === DecisionLookupStatus.NOT_FOUND) {
      return {
        artifact,
        lookupStatus: DecisionLookupStatus.NOT_FOUND,
      };
    }

    if (lookupStatus === DecisionLookupStatus.FOUND) {
      return {
        artifact,
        lookupStatus: DecisionLookupStatus.FOUND,
        decision: this.adaptDecisionRecord(artifact, rawResult),
      };
    }

    throw new DecisionLookupInvalidResponseError(
      `unsupported lookupStatus "${String(lookupStatus)}" for `
      + `"${this.describe(artifact)}"`,
    );
  }

  // 응답이 요청과 다른 Package를 가리키면 판정을 엉뚱한 Package에 적용하게 된다
  private assertIdentityMatches(
    artifact: ArtifactIdentity,
    rawResult: Record<string, unknown>,
  ): void {
    if (rawResult.packageName !== artifact.packageName) {
      throw new DecisionLookupInvalidResponseError(
        `expected packageName "${artifact.packageName}", `
        + `received "${String(rawResult.packageName)}"`,
      );
    }

    if (rawResult.version !== artifact.version) {
      throw new DecisionLookupInvalidResponseError(
        `expected version "${artifact.version}" for `
        + `"${artifact.packageName}", received "${String(rawResult.version)}"`,
      );
    }

    // 합의된 계약은 packageName / version / integrity 세 값이 모두 일치할 때만
    // FOUND다. integrity를 비교하지 않으면 다른 Artifact에 내려진 판정을
    // 우리 Artifact에 적용하게 된다.
    const responseIntegrity = rawResult.integrity ?? null;

    if (responseIntegrity !== artifact.integrity) {
      throw new DecisionLookupInvalidResponseError(
        `expected integrity "${String(artifact.integrity)}" for `
        + `"${this.describe(artifact)}", `
        + `received "${String(responseIntegrity)}"`,
      );
    }
  }

  private adaptDecisionRecord(
    artifact: ArtifactIdentity,
    rawResult: Record<string, unknown>,
  ): DecisionRecord {
    const { decision, decisionId } = rawResult;

    // FOUND는 "판정 기록이 있다"는 뜻이며 그 판정이 REJECT일 수 있다.
    // decision 값이 없으면 허용과 차단을 구분할 수 없으므로 통과시키지 않는다.
    if (typeof decision !== 'string' || !DECISION_VALUES.has(decision)) {
      throw new DecisionLookupInvalidResponseError(
        `FOUND result for "${this.describe(artifact)}" must include a valid `
        + `decision, received "${String(decision)}"`,
      );
    }

    if (typeof decisionId !== 'string' || !decisionId.trim()) {
      throw new DecisionLookupInvalidResponseError(
        `FOUND result for "${this.describe(artifact)}" must include decisionId`,
      );
    }

    return {
      decisionId,
      // 현재 Decision DB는 npm만 다루므로 Gateway가 채운다
      ecosystem: 'npm',
      packageName: artifact.packageName,
      version: artifact.version,
      integrity: artifact.integrity,
      decision: decision as Decision,
      ...this.optionalString(rawResult.policyKey, 'policyKey'),
      ...this.optionalString(rawResult.policyVersion, 'policyVersion'),
      evaluatedAt: typeof rawResult.evaluatedAt === 'string'
        ? rawResult.evaluatedAt
        : '',
    };
  }

  private optionalString(
    value: unknown,
    key: 'policyKey' | 'policyVersion',
  ): Record<string, string> {
    return typeof value === 'string' && value.trim()
      ? { [key]: value }
      : {};
  }

  private describe(artifact: ArtifactIdentity): string {
    return `${artifact.packageName}@${artifact.version}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value);
  }
}
