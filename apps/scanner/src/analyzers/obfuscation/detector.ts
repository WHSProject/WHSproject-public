/**
 * 난독화 판정.
 *
 * 신호를 구조/데이터 두 갈래로 나눠서 내보낸다. 필요한 복원기가 다르기 때문이다.
 *   구조 신호 → webcrack      (문자열 배열, 제어흐름 평탄화)
 *   데이터 신호 → Babel AST    (base64, fromCharCode, 이스케이프)
 *
 * 이 구분이 없으면 모든 파일에 모든 도구를 돌리게 된다.
 */
import type {
  CandidateContext,
  CandidateReason,
  FileVerdict,
  ObfuscationSignal,
} from './obfuscation.types';
import { extractFeatures } from './features';
import { hasStaticOrderDispatch } from './static-order-dispatch';

/**
 * 임계치. 소표본 실측 기준 초기값이며 평가셋으로 재측정해 조정한다.
 * 발표에서 "이 값은 어디서 나왔나"가 반드시 나오므로 근거를 문서에 남긴다.
 */
export const THRESHOLDS = {
  hexIdRatio: 0.015,
  minHexIdentifiers: 2,
  controlFlowIndirections: 1,
  /**
   * helper 간접호출이 이 수 이상이면 while/switch 평탄화 패턴이나 다른 보조 신호가 없어도
   * 제어흐름 난독화 후보로 본다.
   *
   * 근거(JsDeObsBench control-flow-flattening 100 + 실전 npm 25 패키지 재측정):
   *   - 제어흐름군 후보 재현율 29% → 61%.
   *   - 원본·압축 대조군 오탐 증가 0.
   *   - 실전 정상 npm 신규 오탐 2파일(lodash)뿐. (임계치 1이면 8파일/2패키지로 과다)
   * 단일·소수 helper(정상 파서/디스패치 루프)를 배제하려고 임계치를 둔다.
   */
  controlFlowIndirectionStrong: 3,
  /**
   * 비율 기반 피처(hexIdRatio)의 최소 크기.
   * 작은 파일은 식별자 몇 개로 비율이 튄다. 데이터 신호에는 적용하지 않는다 —
   * 10줄짜리 파일도 eval(Buffer.from(...)) 하나로 충분히 의심스럽다.
   */
  minBytesForRatio: 200,
} as const;

/** 점수 가중치. 구조 신호가 판정을 지배하고 데이터 신호는 점수만 올린다. */
const WEIGHTS: Record<ObfuscationSignal, number> = {
  IDENTIFIER_MANGLING: 0.45,
  CONTROL_FLOW_FLATTENING: 0.35,
  SELF_DEFENDING: 0.35,
  DEBUG_PROTECTION: 0.35,
  BASE64_DECODE: 0.10,
  CHAR_CODE: 0.05,
  ESCAPED_LITERAL: 0.05,
  HEX_LITERAL: 0.05,
  LONG_ENCODED_BLOB: 0.05,
  DYNAMIC_EVAL: 0.05,
};

const STRUCTURAL_SIGNALS: ReadonlySet<ObfuscationSignal> = new Set([
  'IDENTIFIER_MANGLING',
  'CONTROL_FLOW_FLATTENING',
  'SELF_DEFENDING',
  'DEBUG_PROTECTION',
]);

const WEAK_SIGNALS: ReadonlySet<ObfuscationSignal> = new Set([
  'BASE64_DECODE',
  'CHAR_CODE',
  'ESCAPED_LITERAL',
  'HEX_LITERAL',
  'LONG_ENCODED_BLOB',
]);

export function detect(
  path: string,
  source: string,
  context: CandidateContext = {},
): FileVerdict {
  const features = extractFeatures(source);
  const signals: ObfuscationSignal[] = [];

  // 구조 신호 — 비율 피처라 최소 크기를 요구한다
  if (
    features.bytes >= THRESHOLDS.minBytesForRatio
    && features.hexIdentifierCount >= THRESHOLDS.minHexIdentifiers
    && features.hexIdRatio >= THRESHOLDS.hexIdRatio
  ) {
    signals.push('IDENTIFIER_MANGLING');
  }
  // while(true)+switch 하나는 esbuild 같은 정상 프로그램에도 존재한다.
  // hex 식별자 또는 helper indirection이 함께 있을 때만 구조 난독화로 본다.
  const hasCffSupportingSignal =
    features.hexIdentifierCount >= THRESHOLDS.minHexIdentifiers
    || features.base64CallCount > 0
    || features.charCodeCount > 0
    || features.escapedLiteralCount > 0
    || features.longEncodedBlobCount > 0
    || features.dynamicEvalCount > 0
    || features.hasSelfDefending
    || features.hasDebugProtection;
  // helper 간접호출이 다수(임계치 이상)면 while/switch 패턴이나 보조 신호가 없어도
  // 제어흐름 난독화로 본다. 단일·소수 helper(정상 파서/디스패치)와 구분하기 위한 임계치다.
  const denseControlFlowIndirection =
    features.controlFlowIndirectionCount >= THRESHOLDS.controlFlowIndirectionStrong;
  if (
    hasStaticOrderDispatch(source)
    || (features.hasControlFlowFlattening
      && features.controlFlowIndirectionCount >= THRESHOLDS.controlFlowIndirections
      && hasCffSupportingSignal)
    || denseControlFlowIndirection
  ) signals.push('CONTROL_FLOW_FLATTENING');
  if (features.hasSelfDefending) signals.push('SELF_DEFENDING');
  if (features.hasDebugProtection) signals.push('DEBUG_PROTECTION');

  // 데이터 신호 — base64 호출이 있어도 그것만으로는 부족하다.
  // 디코드해서 텍스트가 나오거나(감춰진 문자열), 동적 실행과 같이 있어야 한다.
  // 이 조건이 없으면 정상 패키지의 base64 이미지·폰트 리소스가 전부 걸린다.
  const hiddenText = features.decodableBlobCount > 0;
  const dynamicExec = features.dynamicEvalCount > 0;
  if (features.base64CallCount > 0 && (hiddenText || dynamicExec)) signals.push('BASE64_DECODE');
  if (features.charCodeCount > 0) signals.push('CHAR_CODE');
  if (features.escapedLiteralCount > 0) signals.push('ESCAPED_LITERAL');
  if (features.longEncodedBlobCount > 0 && hiddenText) signals.push('LONG_ENCODED_BLOB');
  if (dynamicExec) signals.push('DYNAMIC_EVAL');

  const structuralCandidate = signals.some((signal) => STRUCTURAL_SIGNALS.has(signal));
  const hasWeakSignal = signals.some((signal) => WEAK_SIGNALS.has(signal));
  const executionPath = context.executionPath === true;
  const riskCapabilityRuleIds = [...new Set(context.riskCapabilityRuleIds ?? [])].sort();
  const candidateReasons: CandidateReason[] = [];

  if (structuralCandidate) candidateReasons.push('STRONG_CONTROL_FLOW_OBFUSCATION');
  // 단일 fromCharCode/escape/base64/blob은 정상 코드에도 흔하다.
  if (dynamicExec && hasWeakSignal) {
    candidateReasons.push('DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL');
  }
  if (riskCapabilityRuleIds.length > 0 && signals.length > 0) {
    candidateReasons.push('RISK_CAPABILITY_WITH_OBFUSCATION_SIGNAL');
  }
  // entry point 자체는 근거가 아니며, weak/structural signal을 강화하는 context로만 사용한다.
  if (executionPath && signals.some((signal) => STRUCTURAL_SIGNALS.has(signal) || WEAK_SIGNALS.has(signal))) {
    candidateReasons.push('EXECUTION_PATH_WITH_OBFUSCATION_SIGNAL');
  }

  const dataCandidate = !structuralCandidate && candidateReasons.length > 0;

  const score = Math.min(1, signals.reduce((sum, signal) => sum + WEIGHTS[signal], 0));

  return {
    path,
    obfuscated: structuralCandidate || dataCandidate,
    score,
    // 데이터 신호 단독을 HIGH 로 올리면 안 된다. 정상 패키지도 base64 리소스를 쓴다.
    confidence: structuralCandidate ? 'HIGH' : 'MEDIUM',
    signals,
    supportingSignals: [...signals],
    candidateReasons,
    executionPath,
    riskCapabilityRuleIds,
    structuralCandidate,
    dataCandidate,
    features,
  };
}
