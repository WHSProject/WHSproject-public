/**
 * 코드 정규화 — 정적 룰이 읽을 수 있는 형태로 표준화한다.
 *
 * JSIMPLIFIER 의 `standardrize.js` 가 하던 일 중 우리에게 필요한 부분만 가져왔다.
 * 복원(decode)이 아니라 **표기 통일**이다. 의미는 바꾸지 않는다.
 *
 * 왜 필요한가 — 실측:
 *
 *   const cp = require('child_process');
 *   cp.exec('id');        ← semgrep 탐지 O
 *   cp['exec']('id');     ← semgrep 탐지 X      ← 여기
 *   p['env']['TOKEN'];    ← semgrep 탐지 X
 *   h['request'](url);    ← semgrep 탐지 X
 *
 * 팀 룰 파일(`rules/custom-rule-analyzer.yml`)의 패턴은 전부 점 표기 기준이다.
 * 그런데 javascript-obfuscator 는 모든 멤버 접근을 계산된 형태로 바꾼다.
 * 구조 복원으로 문자열 배열을 되돌려도 `obj["method"]` 형태가 남아 룰이 안 걸린다.
 *
 * 이 변환이 그 간극을 메운다.
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { babelLineMapping, identityLineMapping } from './line-mapping';
import type { SourceLineMapping } from './obfuscation.types';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default
  ?? _generate) as typeof _generate;

/** 유효한 JS 식별자만 점 표기로 바꿀 수 있다. `a['b-c']` 는 그대로 둔다. */
const VALID_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 예약어는 점 표기가 가능하지만 혼란을 줄이기 위해 제외한다. */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
]);

export interface NormalizeResult {
  code: string;
  changed: boolean;
  /** 점 표기로 바꾼 멤버 접근 수 */
  memberAccessNormalized: number;
  lineMapping: SourceLineMapping;
}

export function normalizeCode(code: string): NormalizeResult {
  let ast;
  try {
    ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true });
  } catch {
    return { code, changed: false, memberAccessNormalized: 0, lineMapping: identityLineMapping('', code) };
  }

  let normalized = 0;

  traverse(ast, {
    // obj['method'] → obj.method
    MemberExpression(path) {
      if (!path.node.computed) return;
      const property = path.node.property;
      if (!t.isStringLiteral(property)) return;
      const name = property.value;
      if (!VALID_IDENTIFIER.test(name) || RESERVED.has(name)) return;

      path.node.property = t.identifier(name);
      path.node.computed = false;
      normalized += 1;
    },

    // { 'key': v } → { key: v } — 룰이 객체 리터럴 키를 볼 때를 위해
    ObjectProperty(path) {
      if (!path.node.computed && t.isStringLiteral(path.node.key)) {
        const name = path.node.key.value;
        if (VALID_IDENTIFIER.test(name) && !RESERVED.has(name)) {
          path.node.key = t.identifier(name);
          normalized += 1;
        }
      }
    },
  });

  if (normalized === 0) return { code, changed: false, memberAccessNormalized: 0, lineMapping: identityLineMapping('', code) };

  const generated = generate(ast, {
    compact: false,
    jsescOption: { minimal: true },
    sourceMaps: true,
    sourceFileName: 'source.js',
  }) as unknown as { code: string; map?: { mappings?: string } | null };
  return {
    code: generated.code,
    changed: true,
    memberAccessNormalized: normalized,
    lineMapping: babelLineMapping('', '', code, generated.code, generated.map),
  };
}
