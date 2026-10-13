import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

function key(node: t.Node): string | null {
  return t.isIdentifier(node) ? node.name : t.isStringLiteral(node) ? node.value : null;
}

/** Eager binary wrappers only. Logical, call, async and receiver semantics are not rewritten. */
function binaryHelper(node: t.Node): node is t.FunctionExpression {
  if (!t.isFunctionExpression(node) || node.async || node.generator || node.id
    || node.params.length !== 2 || node.body.directives.length !== 0
    || node.body.body.length !== 1) return false;
  const [left, right] = node.params;
  if (!t.isIdentifier(left) || !t.isIdentifier(right) || left.name === right.name) return false;
  const ret = node.body.body[0];
  return t.isReturnStatement(ret) && t.isBinaryExpression(ret.argument)
    && t.isIdentifier(ret.argument.left, { name: left.name })
    && t.isIdentifier(ret.argument.right, { name: right.name });
}

function forwardsParameters(fn: t.FunctionExpression): boolean {
  if (!fn.params.length || !fn.params.every((p) => t.isIdentifier(p)) || fn.body.body.length !== 1) return false;
  const names = new Set(fn.params.map((p) => (p as t.Identifier).name));
  const statement = fn.body.body[0];
  if (!t.isReturnStatement(statement)) return false;
  const exp = statement.argument;
  const argument = (n: t.Node): boolean => t.isIdentifier(n) && names.has(n.name)
    || t.isNumericLiteral(n) || t.isStringLiteral(n) || t.isBooleanLiteral(n);
  if (t.isBinaryExpression(exp) || t.isLogicalExpression(exp)) return argument(exp.left) && argument(exp.right)
    && (t.isIdentifier(exp.left) || t.isIdentifier(exp.right));
  return t.isCallExpression(exp) && t.isIdentifier(exp.callee) && names.has(exp.callee.name)
    && exp.arguments.every(argument);
}

/** Count argument-forwarding helpers, not Babel export getters or code-shaped strings. */
export function countHelperDefinitions(source: string): number {
  if (!source.includes('function') || !source.includes('return')) return 0;
  try {
    let count = 0;
    traverse(parse(source, { sourceType: 'unambiguous' }), {
      ObjectProperty(p) {
        const fn = p.node.value;
        if (t.isFunctionExpression(fn) && forwardsParameters(fn)) count++;
      },
    });
    return count;
  } catch { return 0; }
}

/** Diagnostic only: number of direct calls through locally declared forwarding helpers. */
export function countHelperCallSites(source: string): number {
  if (!source.includes('function') || !source.includes('return')) return 0;
  try {
    let count = 0;
    traverse(parse(source, { sourceType: 'unambiguous' }), {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return;
        const names = new Set(p.node.init.properties.flatMap((prop) =>
          t.isObjectProperty(prop) && !prop.computed && t.isFunctionExpression(prop.value)
            && forwardsParameters(prop.value) ? [key(prop.key)] : []));
        const binding = p.scope.getBinding(p.node.id.name);
        for (const ref of binding?.referencePaths ?? []) {
          const member = ref.parentPath;
          if (!member?.isMemberExpression() || member.node.object !== ref.node) continue;
          const name = member.node.computed
            ? t.isStringLiteral(member.node.property) ? member.node.property.value : null
            : key(member.node.property);
          if (name !== null && names.has(name) && member.parentPath.isCallExpression()
            && member.parentPath.node.callee === member.node) count++;
        }
      },
    });
    return count;
  } catch { return 0; }
}

export interface HelperReduction { code: string; replacements: number }

/**
 * Static reduction on analysis copies only. No evaluation of input code.
 * Reject escaping/mutable objects, dynamic keys, spread/getters and direct eval.
 * Assumes ordinary lexical bindings (not a host rewriting globals during execution).
 */
export function reduceBinaryHelpers(source: string): HelperReduction {
  const unchanged = { code: source, replacements: 0 };
  if (!source.includes('function') || !source.includes('return')) return unchanged;
  try {
    const ast = parse(source, { sourceType: 'unambiguous' });
    let dynamicScope = false;
    traverse(ast, {
      WithStatement() { dynamicScope = true; },
      CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamicScope = true; },
    });
    if (dynamicScope) return unchanged;
    let replacements = 0;
    traverse(ast, {
      VariableDeclarator(p) {
        if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return;
        const props = new Map<string, t.Expression>();
        for (const prop of p.node.init.properties) {
          if (!t.isObjectProperty(prop) || prop.computed || !t.isExpression(prop.value)) return;
          const name = key(prop.key);
          if (name === null || name === '__proto__' || props.has(name)) return;
          if (!t.isFunctionExpression(prop.value) && !t.isStringLiteral(prop.value)
            && !t.isNumericLiteral(prop.value) && !t.isBooleanLiteral(prop.value)) return;
          props.set(name, prop.value);
        }
        if (![...props.values()].some(binaryHelper)) return;
        const binding = p.scope.getBinding(p.node.id.name);
        if (!binding || binding.constantViolations.length || !binding.referencePaths.length) return;
        // Retain declarations: unused helper functions and non-binary calls keep their semantics.
        const references = [...binding.referencePaths];
        for (const ref of references) {
          const member = ref.parentPath;
          if (!member?.isMemberExpression() || member.node.object !== ref.node) return;
          const name = member.node.computed
            ? t.isStringLiteral(member.node.property) ? member.node.property.value : null
            : key(member.node.property);
          if (name === null || !props.has(name)) return;
          const use = member.parentPath;
          if (!use.isCallExpression() || use.node.callee !== member.node) {
            // Literal values may be read, but no writes, delete, destructuring or escapes.
            if (!t.isLiteral(props.get(name)) || !member.isReferenced()) return;
            if (use.isAssignmentExpression() || use.isUpdateExpression() || use.isUnaryExpression({ operator: 'delete' })) return;
          } else if (!t.isFunctionExpression(props.get(name))) return;
          if ((ref.node.start ?? -1) < (p.node.end ?? Infinity)) return;
        }
        for (const ref of references.reverse()) {
          const member = ref.parentPath;
          if (!member?.isMemberExpression()) continue;
          const name = member.node.computed ? (member.node.property as t.StringLiteral).value : key(member.node.property);
          const fn = name === null ? undefined : props.get(name);
          const call = member.parentPath;
          if (!fn || !binaryHelper(fn) || !call.isCallExpression() || call.node.arguments.length !== 2
            || !call.node.arguments.every((arg) => t.isExpression(arg))) continue;
          // Moving a reference from an outer lexical environment into an earlier closure can
          // bypass the original initialization/TDZ error. Only reduce same-function uses.
          if (call.getFunctionParent()?.node !== p.getFunctionParent()?.node) continue;
          const ret = fn.body.body[0] as t.ReturnStatement;
          const expression = ret.argument as t.BinaryExpression;
          const [left, right] = call.node.arguments as [t.Expression, t.Expression];
          call.replaceWith(t.binaryExpression(expression.operator, t.cloneNode(left, true), t.cloneNode(right, true)));
          replacements++;
        }
      },
    });
    return replacements ? { code: generate(ast).code, replacements } : unchanged;
  } catch { return unchanged; }
}
