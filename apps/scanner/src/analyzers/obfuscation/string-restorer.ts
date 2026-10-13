/**
 * Babel 기반 결정적 문자열 복원.
 *
 * 실행 없이 계산 가능한 인코딩만 푼다. 동적 분석이 아니고 샌드박스도 필요 없다.
 *
 * 다루는 것
 *   Base64        Buffer.from(lit,'base64').toString()  /  atob(lit)
 *   Hex           Buffer.from(lit,'hex').toString()
 *   Unicode       \uXXXX / \xXX  (파서가 이미 해석하므로 생성 시 평문으로 나온다)
 *   CharCode      String.fromCharCode(...)
 *   문자열 결합    'a' + 'b'  /  템플릿 리터럴(치환 없는 것)
 *   URI           decodeURIComponent(lit) / unescape(lit)
 *   상수 인라인    같은 문장 목록에서 초기화가 선행하는 문자열 바인딩
 *   eval 승격      선언·directive 없는 표현식 문장만 승격 후 재폴딩
 *
 * 다루지 않는 것 (의도적)
 *   런타임 값에 의존하는 디코딩, 원격 payload, 동적 로더
 *   → 복원하지 않고 UNRESOLVED 로 남겨 LLM 대상 선별로 넘긴다
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { babelLineMapping, composeLineMappings, identityLineMapping } from './line-mapping';
import type { SourceLineMapping } from './obfuscation.types';

export interface ExtractedPayload {
  code: string;
  sourceLine: number | null;
  transform: 'EVAL_PROMOTE';
}

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default
  ?? _generate) as typeof _generate;

export interface StringRestoreResult {
  code: string;
  changed: boolean;
  rounds: number;
  transformations: string[];
  /** eval 로 승격돼 분리 가능한 payload. 별도 파일로 저장해 재분석한다. */
  payloads: ExtractedPayload[];
  lineMapping: SourceLineMapping;
}

const MAX_DECODED_BYTES = 262_144;

const decode = (value: string, encoding: BufferEncoding, outputEncoding: BufferEncoding): string | null => {
  try {
    const decoded = Buffer.from(value, encoding).toString(outputEncoding);
    return Buffer.byteLength(decoded, 'utf8') <= MAX_DECODED_BYTES ? decoded : null;
  } catch {
    return null;
  }
};

const parseOptions = { sourceType: 'unambiguous', errorRecovery: true } as const;

/**
 * 멤버 접근의 속성 이름을 돌려준다. 점 표기(obj.foo)와 계산된 표기(obj['foo']) 둘 다 처리한다.
 * javascript-obfuscator 는 String['fromCharCode'] 처럼 모든 멤버를 계산된 형태로 바꾸므로
 * 이걸 처리하지 않으면 STRING 단계(NORMALIZE 앞)에서 fromCharCode/Buffer.from 을 놓친다.
 */
function memberProp(callee: t.Node): string | null {
  if (!t.isMemberExpression(callee)) return null;
  if (!callee.computed && t.isIdentifier(callee.property)) return callee.property.name;
  if (callee.computed && t.isStringLiteral(callee.property)) return callee.property.value;
  return null;
}

/** 멤버 접근의 객체가 식별자면 그 이름 (예: Buffer, String). */
function memberObjName(callee: t.Node): string | null {
  if (!t.isMemberExpression(callee)) return null;
  return t.isIdentifier(callee.object) ? callee.object.name : null;
}

function isStringValueReference(path: NodePath<t.Identifier>): boolean {
  // Babel의 참조 판정에는 export local과 일부 쓰기 위치도 포함된다.
  return path.isReferencedIdentifier()
    && !path.parentPath.isExportSpecifier()
    && !path.isBindingIdentifier();
}

/** No control-flow inference: require a preceding declaration in the same body. */
function initializedBefore(binding: Binding, reference: NodePath): boolean {
  const declaration = binding.path.parentPath;
  if (declaration?.isVariableDeclaration() !== true || declaration.listKey !== 'body'
    || binding.path.getFunctionParent() !== reference.getFunctionParent()) return false;
  // A replaced eval statement can leave queued, detached identifier paths.
  // findParent safely returns null for those; getStatementParent would throw.
  const statement = reference.findParent((parent) => parent.isStatement());
  if (statement === declaration) {
    const declarator = reference.findParent((parent) => parent.isVariableDeclarator());
    return declarator?.parentPath === declaration
      && typeof binding.path.key === 'number' && typeof declarator.key === 'number'
      && binding.path.key < declarator.key;
  }
  return statement !== null
    && statement.parentPath === declaration.parentPath
    && typeof declaration.key === 'number'
    && typeof statement.key === 'number'
    && declaration.key < statement.key;
}

function isBuiltin(path: NodePath, name: string): boolean {
  return path.scope.getBinding(name) === undefined
    && !path.findParent((parent) => parent.isWithStatement());
}

export function restoreStrings(code: string, maxRounds = 5): StringRestoreResult {
  let current = code;
  let anyChange = false;
  let round = 0;
  const transformations: string[] = [];
  const payloads: ExtractedPayload[] = [];
  let lineMapping = identityLineMapping('', code);

  while (round < maxRounds) {
    round += 1;
    let changed = false;
    const ast = parse(current, parseOptions);

    // Direct eval can modify let/var without Babel recording a constant violation.
    // `with` can override even a lexically constant reference.
    let hasDirectEval = false;
    let hasWith = false;
    traverse(ast, {
      CallExpression(path) {
        if (t.isIdentifier(path.node.callee, { name: 'eval' }) && isBuiltin(path, 'eval')) hasDirectEval = true;
      },
      WithStatement() { hasWith = true; },
    });

    // 이름이 같아도 다른 스코프의 변수는 별개다. 재대입 없는 문자열 바인딩만 수집한다.
    const constants = new Map<Binding, string>();
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id) || !t.isStringLiteral(path.node.init)) return;
        const binding = path.scope.getBinding(path.node.id.name);
        if (binding?.constant === true && !hasWith && (!hasDirectEval || binding.kind === 'const')) {
          constants.set(binding, path.node.init.value);
        }
      },
    });

    /** 호출 인자도 참조 위치의 바인딩으로 조회하여 shadowing/미선언 변수를 보존한다. */
    const literalOf = (path: NodePath | undefined): string | null => {
      if (path === undefined) return null;
      if (path.isStringLiteral()) return path.node.value;
      if (path.isIdentifier()) {
        const binding = path.scope.getBinding(path.node.name);
        return binding === undefined || !initializedBefore(binding, path) ? null : constants.get(binding) ?? null;
      }
      return null;
    };

    traverse(ast, {
      Identifier(path) {
        if (!isStringValueReference(path)) return;
        const value = literalOf(path);
        if (value === null) return;
        path.replaceWith(t.stringLiteral(value));
        changed = true;
        transformations.push('CONST_INLINE');
      },

      CallExpression(path) {
        const callee = path.node.callee;
        const args = path.node.arguments;
        const argumentPaths = path.get('arguments');
        // babel 의 isIdentifier(node, opts) 타입 가드는 else 분기에서 Identifier 를 제거한다.
        // 이름을 먼저 뽑아 두고 비교해야 아래 분기들이 좁혀지지 않는다.
        const calleeName = callee.type === 'Identifier' ? callee.name : null;

        // atob(literal)
        if (calleeName === 'atob' && isBuiltin(path, 'atob') && args.length === 1) {
          const arg = literalOf(argumentPaths[0]);
          if (arg === null) return;
          try {
            // Buffer's permissive Base64 parser and UTF-8 conversion do not
            // implement atob's validation and binary-string semantics.
            const value = atob(arg);
            if (Buffer.byteLength(value, 'utf8') > MAX_DECODED_BYTES) return;
            path.replaceWith(t.stringLiteral(value));
            changed = true;
            transformations.push('BASE64_ATOB');
          } catch { /* invalid Base64 must keep its runtime exception */ }
          return;
        }

        // Fold the entire Buffer.from(...).toString(...) chain, never the Buffer
        // itself. Extra/dynamic arguments may have side effects and stay intact.
        if (
          t.isMemberExpression(callee)
          && memberProp(callee) === 'toString'
          && t.isCallExpression(callee.object)
          && memberObjName(callee.object.callee) === 'Buffer'
          && memberProp(callee.object.callee) === 'from'
          && isBuiltin(path, 'Buffer')
        ) {
          const input = callee.object.arguments;
          if (input.length !== 2 || args.length > 1) return;
          const inputPaths = (path.get('callee') as NodePath<t.MemberExpression>)
            .get('object') as NodePath<t.CallExpression>;
          const data = literalOf(inputPaths.get('arguments')[0]);
          const encoding = t.isStringLiteral(input[1]) ? input[1].value : null;
          const outputEncoding = args.length === 0 ? 'utf8' : t.isStringLiteral(args[0]) ? args[0].value : null;
          if (data === null || (encoding !== 'base64' && encoding !== 'hex')
            || outputEncoding === null || !Buffer.isEncoding(outputEncoding)) return;
          const value = decode(data, encoding, outputEncoding);
          if (value === null) return;
          path.replaceWith(t.stringLiteral(value));
          changed = true;
          transformations.push(encoding === 'hex' ? 'HEX_BUFFER' : 'BASE64_BUFFER');
          return;
        }

        // "이미 문자열이 된 것".toString(...) 벗기기
        // JSIMPLIFIER 가 여기서 막혔다 — 네이티브 평가 목록에 toString 이 없어 체인이 끊긴다.
        if (
          t.isMemberExpression(callee)
          && memberProp(callee) === 'toString'
          && t.isStringLiteral(callee.object)
          && args.length === 0
        ) {
          path.replaceWith(callee.object);
          changed = true;
          transformations.push('TOSTRING_UNWRAP');
          return;
        }

        // String.fromCharCode(...)  (계산된 String['fromCharCode'] 포함)
        if (
          t.isMemberExpression(callee)
          && memberObjName(callee) === 'String'
          && memberProp(callee) === 'fromCharCode'
          && isBuiltin(path, 'String')
          && args.every((arg) => t.isNumericLiteral(arg))
        ) {
          const codes = args.map((arg) => (arg as t.NumericLiteral).value);
          if (codes.some((code) => !Number.isInteger(code) || code < 0 || code > 0xffff)) return;
          path.replaceWith(t.stringLiteral(String.fromCharCode(...codes)));
          changed = true;
          transformations.push('CHAR_CODE');
          return;
        }

        // decodeURIComponent / unescape
        if ((calleeName === 'decodeURIComponent' || calleeName === 'unescape')
          && isBuiltin(path, calleeName) && args.length === 1) {
          const arg = literalOf(argumentPaths[0]);
          if (arg === null) return;
          try {
            const value = calleeName === 'unescape' ? unescape(arg) : decodeURIComponent(arg);
            path.replaceWith(t.stringLiteral(value));
            changed = true;
            transformations.push('URI_DECODE');
          } catch { /* 잘못된 시퀀스는 그대로 둔다 */ }
          return;
        }

        // eval("리터럴") → 코드로 승격. 다음 라운드에서 내부가 다시 폴딩된다.
        //
        // 승격은 eval 호출이 "문장 그 자체"일 때만 고려한다.
        //    부모(ExpressionStatement)를 문장 배열로 교체하기 때문이다.
        //    const x = eval("..")  (대입) / f(eval(".."))  (인자) / return eval("..")
        //    같은 표현식 컨텍스트에서 부모를 교체하면 감싼 코드(대입 대상·호출·return)가
        //    통째로 사라지거나 AST 가 깨진다. 그런 경우는 승격하지 않고 UNRESOLVED 로 남겨
        //    LLM 선별로 넘긴다(원래 설계 의도: 런타임 의존/동적 로더는 LLM 이 판단).
        if (calleeName === 'eval' && isBuiltin(path, 'eval') && args.length === 1) {
          const parent = path.parentPath;
          if (parent === null || !parent.isExpressionStatement()) return;
          const arg = literalOf(argumentPaths[0]);
          if (arg === null) return;
          try {
            const sub = parse(arg, { sourceType: 'script', errorRecovery: false, strictMode: path.isInStrictMode() });
            // Moving declarations or strict directives into the enclosing body
            // changes eval's scope. Keep such payloads in the original call.
            if (sub.program.directives.length > 0 || !sub.program.body.every((node) => t.isExpressionStatement(node))) return;
            payloads.push({
              code: arg,
              sourceLine: path.node.loc?.start.line ?? null,
              transform: 'EVAL_PROMOTE',
            });
            parent.replaceWithMultiple(sub.program.body);
            changed = true;
            transformations.push('EVAL_PROMOTE');
          } catch { /* 파싱 불가 → 원본 유지 */ }
        }
      },

      // 'a' + 'b'
      BinaryExpression(path) {
        if (path.node.operator !== '+') return;
        if (!t.isStringLiteral(path.node.left) || !t.isStringLiteral(path.node.right)) return;
        path.replaceWith(t.stringLiteral(path.node.left.value + path.node.right.value));
        changed = true;
        transformations.push('STRING_CONCAT');
      },

      // 치환 없는 템플릿 리터럴
      TemplateLiteral(path) {
        if (path.parentPath.isTaggedTemplateExpression()) return;
        if (path.node.expressions.length > 0) return;
        const value = path.node.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
        path.replaceWith(t.stringLiteral(value));
        changed = true;
        transformations.push('TEMPLATE_FOLD');
      },
    });

    // Babel stores actual directives separately. A StringLiteral expression
    // produced by folding must not become a new directive when re-parsed.
    traverse(ast, {
      ExpressionStatement(path) {
        if (t.isStringLiteral(path.node.expression)) {
          path.node.expression = t.parenthesizedExpression(path.node.expression);
        }
      },
    });

    const generated = generate(ast, {
      compact: false,
      jsescOption: { minimal: true },
      sourceMaps: true,
      sourceFileName: 'source.js',
    }) as unknown as { code: string; map?: { mappings?: string } | null };
    const next = babelLineMapping('', '', current, generated.code, generated.map);
    lineMapping = composeLineMappings(next, lineMapping);
    current = generated.code;
    if (!changed) break;
    anyChange = true;
  }

  return {
    code: current,
    changed: anyChange,
    rounds: round,
    transformations: [...new Set(transformations)].sort(),
    payloads,
    lineMapping,
  };
}
