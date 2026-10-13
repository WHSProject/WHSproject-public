/**
 * 난독화 피처 추출. 순수 함수라 테스트가 쉽다.
 *
 * 피처 선택은 실측으로 정했다. 정상 번들을 난독화로 오판하는 피처를 쓰면 안 된다.
 *
 *   피처                  난독화샘플  terser minify  axios.min.js(정상)
 *   hexIdRatio (_0x....)    0.439         0              0        ← 사용
 *   제어흐름 평탄화           true        false          false     ← 사용
 *   긴 base64 문자열           2            0              0       ← 보조
 *   최대 줄 길이            3,343        396         51,264       ← 사용 금지
 *   문자열 배열 존재          true        false          true      ← 사용 금지
 *   엔트로피                  —            —              —       ← 사용 금지
 *
 * 줄 길이·문자열 배열·엔트로피를 쓰면 정상 dist 번들이 전부 걸린다.
 */
import type { ObfuscationFeatures } from './obfuscation.types';

import { countHelperDefinitions } from './helper-analysis';

export const PATTERNS = {
  identifier: /[A-Za-z_$][A-Za-z0-9_$]*/g,
  /** javascript-obfuscator 의 hexadecimal identifier 생성 결과 */
  hexIdentifier: /\b_0x[0-9a-f]{4,}\b/g,
  controlFlowFlattening: /while\s*\(\s*!!\[\]\s*\)|while\s*\(\s*true\s*\)\s*\{\s*switch/,
  /** { 'op': function (x, y) { return x + y; } } 형태의 간접 실행 helper. */
  controlFlowIndirection: /['"][A-Za-z_$][A-Za-z0-9_$]*['"]\s*:\s*function\s*\([^)]*\)\s*\{\s*return\b/g,
  /** javascript-obfuscator selfDefending의 고정 정규식. */
  selfDefending: '(((.+)+)+)+$',
  /** javascript-obfuscator debugProtection의 재귀 함수명·동적 debugger 생성. */
  debugProtection: /debuggerProtection|['"]constructor['"]\]\s*\(\s*['"]while\\x20\(true\)/,
  base64Call: /\batob\s*\(|Buffer\s*\.\s*from\s*\([^)]*['"]base64['"]|Base64\s*\.\s*decode\s*\(/g,
  charCode: /String\s*\.\s*fromCharCode\s*\(/g,
  escapedLiteral: /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g,
  longEncodedBlob: /['"][A-Za-z0-9+/]{40,}={0,2}['"]/g,
  dynamicEval: /\beval\s*\(|new\s+Function\s*\(|\bvm\s*\.\s*runIn\w+/g,
} as const;

const count = (source: string, re: RegExp): number => (source.match(re) ?? []).length;

/**
 * base64 리터럴을 실제로 디코드해서 "감춰진 텍스트"인지 "바이너리 리소스"인지 가른다.
 *
 * 이 구분이 없으면 정상 패키지의 base64 이미지·폰트 리소스가 전부 난독화로 걸린다.
 * 실제로 fixture 09(투명 PNG 1픽셀)가 이 피처 없이는 오탐이었다.
 *
 * 복원의 목적은 정적 분석기가 못 보는 "코드·문자열"을 드러내는 것이다.
 * PNG 바이너리는 복원해도 분석기가 읽을 게 없다.
 */
const PRINTABLE = /[\t\n\r\x20-\x7e]/;

function countDecodableBlobs(source: string): number {
  let decodable = 0;
  for (const match of source.matchAll(/['"]([A-Za-z0-9+/]{16,}={0,2})['"]/g)) {
    const raw = match[1];
    if (raw === undefined || raw.length % 4 !== 0) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (decoded.length === 0) continue;
    let printable = 0;
    for (const char of decoded) if (PRINTABLE.test(char)) printable += 1;
    // 출력 가능 문자가 90% 이상이면 감춰진 텍스트로 본다.
    if (printable / decoded.length >= 0.9) decodable += 1;
  }
  return decodable;
}

export function extractFeatures(source: string): ObfuscationFeatures {
  const identifierCount = count(source, PATTERNS.identifier);
  const hexIdentifierCount = count(source, PATTERNS.hexIdentifier);

  return {
    bytes: source.length,
    lines: source.split('\n').length,
    identifierCount,
    hexIdentifierCount,
    // 절대 개수가 아니라 비율을 쓴다. 큰 파일이면 개수는 자동으로 커진다.
    hexIdRatio: identifierCount === 0 ? 0 : hexIdentifierCount / identifierCount,
    hasControlFlowFlattening: PATTERNS.controlFlowFlattening.test(source),
    controlFlowIndirectionCount: countHelperDefinitions(source),
    hasSelfDefending: source.includes(PATTERNS.selfDefending),
    hasDebugProtection: PATTERNS.debugProtection.test(source),
    base64CallCount: count(source, PATTERNS.base64Call),
    charCodeCount: count(source, PATTERNS.charCode),
    escapedLiteralCount: count(source, PATTERNS.escapedLiteral),
    longEncodedBlobCount: count(source, PATTERNS.longEncodedBlob),
    decodableBlobCount: countDecodableBlobs(source),
    dynamicEvalCount: count(source, PATTERNS.dynamicEval),
  };
}
