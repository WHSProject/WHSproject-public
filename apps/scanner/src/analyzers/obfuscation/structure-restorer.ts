/**
 * webcrack 기반 구조 복원.
 *
 * 문자열 배열 되돌리기, 제어흐름 평탄화 해제, 번들 분해를 담당한다.
 * 실측: javascript-obfuscator 기본 프리셋 2,515 bytes → 244 bytes, 82ms.
 *
 * 문자열 복원(string-restorer)과 담당 영역이 다르다. 순서가 고정이다.
 *   구조 복원 → 문자열 복원
 * 반대로 하면 문자열 배열 안에 숨은 base64 literal 을 문자열 복원이 보지 못한다.
 *
 * 설치돼 있지 않아도 파이프라인을 죽이지 않고 SKIPPED 로 넘어간다.
 */
import { createRequire } from 'node:module';
import { anchorLineMapping, identityLineMapping } from './line-mapping';
import type { SourceLineMapping } from './obfuscation.types';
import { countHelperDefinitions, countHelperCallSites, reduceBinaryHelpers } from './helper-analysis';
import { hasStaticOrderDispatch, restoreStaticOrderDispatch } from './static-order-dispatch';
import { structuralFingerprint } from './structure-quality';

export interface StructureRestoreResult {
  status: 'COMPLETED' | 'NO_CHANGE' | 'FAILED' | 'UNAVAILABLE';
  code?: string;
  reason?: string;
  lineMapping?: SourceLineMapping;
  durationMs: number;
  /** Internal diagnostics. Completion is not proof that every obfuscation was removed. */
  diagnostics?: Record<string, number | boolean>;
}

type WebcrackFn = (code: string) => Promise<{ code: string }>;
let cached: WebcrackFn | null | undefined;

// webcrack 2.16의 공식 CommonJS 진입점을 지연 로딩한다.
// 분석 대상 코드를 require하거나 실행하는 용도가 아니다.
const requireFromHere = createRequire(__filename);

async function loadWebcrack(): Promise<WebcrackFn | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = requireFromHere('webcrack') as { webcrack: WebcrackFn };
    cached = mod.webcrack;
  } catch {
    cached = null;
  }
  return cached;
}

export async function restoreStructure(
  code: string,
  timeoutMs = 5_000,
): Promise<StructureRestoreResult> {
  const startedAt = Date.now();
  const webcrack = await loadWebcrack();
  if (webcrack === null) {
    return { status: 'UNAVAILABLE', reason: 'webcrack is not installed', durationMs: Date.now() - startedAt };
  }

  let output: string;
  let diagnostics: StructureRestoreResult['diagnostics'];
  let timeout: NodeJS.Timeout | undefined;
  try {
    output = await Promise.race([
      webcrack(code).then((result) => result.code),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`webcrack timeout ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    if (Date.now() - startedAt > timeoutMs) throw new Error('structure restore budget exceeded');
    // Independent static passes: webcrack may skip these when no string-array decoder exists.
    const dispatch = restoreStaticOrderDispatch(output);
    const helpers = reduceBinaryHelpers(dispatch.code);
    output = helpers.code;
    const syntaxChanged = structuralFingerprint(code) !== structuralFingerprint(output);
    diagnostics = {
      staticDispatchBefore: hasStaticOrderDispatch(code),
      staticDispatchAfter: hasStaticOrderDispatch(output),
      helperDefinitionsBefore: countHelperDefinitions(code),
      helperDefinitionsAfter: countHelperDefinitions(output),
      helperCallsBefore: countHelperCallSites(code),
      helperCallsAfter: countHelperCallSites(output),
      dispatchersFlattened: dispatch.flattened,
      binaryCallsReduced: helpers.replacements,
      syntaxChanged,
    };
    if (Date.now() - startedAt > timeoutMs) throw new Error('structure restore budget exceeded');
  } catch (error) {
    return {
      status: 'FAILED',
      reason: String((error as Error).message).slice(0, 200),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  if (output === code || diagnostics?.syntaxChanged === false) {
    return {
      status: 'NO_CHANGE',
      reason: 'NO_STRUCTURAL_CHANGE',
      diagnostics,
      lineMapping: identityLineMapping('', code),
      durationMs: Date.now() - startedAt,
    };
  }
  return {
    status: 'COMPLETED',
    code: output,
    diagnostics,
    lineMapping: anchorLineMapping('', '', code, output),
    durationMs: Date.now() - startedAt,
  };
}
