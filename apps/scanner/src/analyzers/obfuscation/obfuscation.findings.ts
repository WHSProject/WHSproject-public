/**
 * 난독화 파트의 Finding 계약.
 *
 * 현재는 Shadow 결과지만 이후 Evidence 매핑에서도 같은 ID를 쓸 수 있도록 고정한다.
 *
 * unresolved / not-selected 를 반드시 올린다.
 * "난독화됐는데 우리 도구로 안 풀린다"는 그 자체가 후속 분석 재료다. 숨기면 오해된다.
 */
import type { Finding } from '../../domain/analysis.types';
import type {
  FileVerdict,
  RestoreResult,
  SelectionResult,
} from './obfuscation.types';

export const OBFUSCATION_RULE_IDS = {
  detected: 'obfuscation.detected',
  identifierMangling: 'obfuscation.technique.identifier-mangling',
  controlFlowFlattening: 'obfuscation.technique.control-flow-flattening',
  encodedString: 'obfuscation.technique.encoded-string',
  dynamicEval: 'obfuscation.technique.dynamic-eval',
  restored: 'obfuscation.restored',
  unresolved: 'obfuscation.unresolved',
  notSelected: 'obfuscation.not-selected',
} as const;

const TECHNIQUE_RULE_ID: Record<string, string> = {
  IDENTIFIER_MANGLING: OBFUSCATION_RULE_IDS.identifierMangling,
  CONTROL_FLOW_FLATTENING: OBFUSCATION_RULE_IDS.controlFlowFlattening,
  SELF_DEFENDING: OBFUSCATION_RULE_IDS.controlFlowFlattening,
  DEBUG_PROTECTION: OBFUSCATION_RULE_IDS.controlFlowFlattening,
  BASE64_DECODE: OBFUSCATION_RULE_IDS.encodedString,
  CHAR_CODE: OBFUSCATION_RULE_IDS.encodedString,
  ESCAPED_LITERAL: OBFUSCATION_RULE_IDS.encodedString,
  HEX_LITERAL: OBFUSCATION_RULE_IDS.encodedString,
  LONG_ENCODED_BLOB: OBFUSCATION_RULE_IDS.encodedString,
  DYNAMIC_EVAL: OBFUSCATION_RULE_IDS.dynamicEval,
};

const ANALYZER = 'obfuscation';

export function buildObfuscationFindings(
  selection: SelectionResult,
  restore: RestoreResult,
  artifactHash: string,
): Finding[] {
  const findings: Finding[] = [];

  for (const verdict of selection.verdicts.filter((v) => v.obfuscated)) {
    findings.push(detectedFinding(verdict, artifactHash));
    for (const technique of new Set(verdict.signals.map((s) => TECHNIQUE_RULE_ID[s]).filter(Boolean))) {
      findings.push({
        findingId: `${ANALYZER}:${technique}:${verdict.path}`,
        ruleId: technique!,
        type: 'OBFUSCATION_TECHNIQUE',
        message: `Obfuscation technique detected in ${verdict.path}`,
        location: { type: 'SOURCE_FILE', path: verdict.path },
        data: { artifactHash, signals: verdict.signals, score: verdict.score },
      });
    }
  }

  for (const file of restore.restored) {
    findings.push({
      findingId: `${ANALYZER}:${OBFUSCATION_RULE_IDS.restored}:${file.path}`,
      ruleId: OBFUSCATION_RULE_IDS.restored,
      type: 'OBFUSCATION_RESTORED',
      message: `${file.status} via ${file.appliedStages.join('+')}`,
      location: { type: 'SOURCE_FILE', path: file.path },
      data: {
        artifactHash,
        appliedStages: file.appliedStages,
        status: file.status,
        reason: file.reason,
        limitations: file.limitations,
        stageResults: file.stageResults,
        originalBytes: file.originalBytes,
        restoredBytes: file.restoredBytes,
        payloadCount: file.payloads.length,
        verifyAfter: file.verifyAfter,
        validation: file.validation,
        durationMs: file.durationMs,
        doesNotProve: 'A restored artifact is derived output; it does not prove the original source contained this code verbatim.',
      },
    });
  }

  for (const file of restore.unresolved) {
    findings.push({
      findingId: `${ANALYZER}:${OBFUSCATION_RULE_IDS.unresolved}:${file.path}`,
      ruleId: OBFUSCATION_RULE_IDS.unresolved,
      type: 'OBFUSCATION_UNRESOLVED',
      message: `Obfuscated file could not be restored (${file.reason})`,
      location: { type: 'SOURCE_FILE', path: file.path },
      data: {
        artifactHash,
        status: file.status,
        reason: file.reason,
        limitations: file.limitations,
        stageResults: file.stageResults,
        validation: file.validation,
        detail: file.detail,
      },
    });
  }

  for (const file of selection.skipped.filter((s) => s.reason === 'TARGET_LIMIT' || s.reason === 'SIZE_LIMIT')) {
    findings.push({
      findingId: `${ANALYZER}:${OBFUSCATION_RULE_IDS.notSelected}:${file.path}`,
      ruleId: OBFUSCATION_RULE_IDS.notSelected,
      type: 'OBFUSCATION_NOT_SELECTED',
      message: `Obfuscated file was not selected for restoration (${file.reason})`,
      location: { type: 'SOURCE_FILE', path: file.path },
      data: { artifactHash, reason: file.reason },
    });
  }

  return findings;
}

function detectedFinding(verdict: FileVerdict, artifactHash: string): Finding {
  return {
    findingId: `${ANALYZER}:${OBFUSCATION_RULE_IDS.detected}:${verdict.path}`,
    ruleId: OBFUSCATION_RULE_IDS.detected,
    type: 'OBFUSCATION',
    message: `Obfuscated source detected (score ${verdict.score.toFixed(2)}, ${verdict.confidence})`,
    location: { type: 'SOURCE_FILE', path: verdict.path },
    data: {
      artifactHash,
      score: verdict.score,
      confidence: verdict.confidence,
      signals: verdict.signals,
      supportingSignals: verdict.supportingSignals,
      candidateReasons: verdict.candidateReasons,
      executionPath: verdict.executionPath,
      riskCapabilityRuleIds: verdict.riskCapabilityRuleIds,
      // 임계치 재조정을 위해 원값을 보존한다. 판정만 저장하면 임계치를 바꿀 때마다 재스캔해야 한다.
      features: verdict.features,
      doesNotProve: 'Obfuscation alone does not prove malicious intent; legitimate packages ship obfuscated bundles.',
    },
  };
}
