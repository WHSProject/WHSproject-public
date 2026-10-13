import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;
type DispatchLoop = NodePath<t.WhileStatement | t.ForStatement>;

function literalKey(node: t.Node | null | undefined): string | null {
  if (t.isStringLiteral(node)) return `string:${node.value}`;
  if (t.isNumericLiteral(node)) return `number:${node.value}`;
  return null;
}

function literalOrder(node: t.Node | null | undefined): string[] | null {
  if (t.isArrayExpression(node)) {
    const keys = node.elements.map(literalKey);
    return keys.every((key): key is string => key !== null) ? keys : null;
  }
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if (!t.isMemberExpression(callee) || !t.isStringLiteral(callee.object)) return null;
  const isSplit = callee.computed
    ? t.isStringLiteral(callee.property, { value: 'split' })
    : t.isIdentifier(callee.property, { name: 'split' });
  const separator = node.arguments[0];
  if (!isSplit || !t.isStringLiteral(separator) || separator.value.length === 0) return null;
  return callee.object.value.split(separator.value).map((key) => `string:${key}`);
}

function unconditional(node: t.Expression): boolean {
  if (t.isBooleanLiteral(node, { value: true })) return true;
  if (t.isNumericLiteral(node, { value: 1 })) return true;
  if (!t.isUnaryExpression(node, { operator: '!' })) return false;
  if (t.isNumericLiteral(node.argument, { value: 0 })) return true;
  return t.isUnaryExpression(node.argument, { operator: '!' })
    && t.isArrayExpression(node.argument.argument)
    && node.argument.argument.elements.length === 0;
}

/** Require a direct preceding declaration, not a conditional or an outer function's binding. */
function initializer(binding: Binding, loop: DispatchLoop): t.Expression | null {
  const declaration = binding.path;
  if (!declaration.isVariableDeclarator() || !t.isIdentifier(declaration.node.id)) return null;
  const statement = declaration.parentPath;
  if (!statement?.isVariableDeclaration() || statement.parentPath.node !== loop.parentPath.node) return null;
  if ((statement.node.end ?? Infinity) > (loop.node.start ?? -1)) return null;
  return t.isExpression(declaration.node.init) ? declaration.node.init : null;
}

/**
 * Static, reordered dispatch table consumed by a cursor in an unconditional loop.
 * This is a candidate signal, not proof of maliciousness or semantic equivalence.
 * No source evaluation, identifier-name heuristics, or sample-specific thresholds.
 */
export function hasStaticOrderDispatch(source: string): boolean {
  return inspectStaticOrderDispatch(source, false).found;
}

export function restoreStaticOrderDispatch(source: string): { code: string; flattened: number } {
  const result = inspectStaticOrderDispatch(source, true);
  return { code: result.code, flattened: result.flattened };
}

function inspectStaticOrderDispatch(source: string, restore: boolean): { found: boolean; code: string; flattened: number } {
  const empty = { found: false, code: source, flattened: 0 };
  // Necessary tokens only: do not reject comments/formatting between AST nodes.
  // Most normal switch statements have neither a cursor increment nor continue.
  if (!source.includes('switch') || !source.includes('++') || !source.includes('continue')) return empty;
  try {
    const ast = parse(source, { sourceType: 'unambiguous', errorRecovery: false });
    if (restore) {
      let dynamicScope = false;
      traverse(ast, {
        WithStatement() { dynamicScope = true; },
        CallExpression(p) { if (t.isIdentifier(p.node.callee, { name: 'eval' })) dynamicScope = true; },
      });
      if (dynamicScope) return empty;
    }
    let found = false;
    let flattened = 0;
    traverse(ast, {
      'WhileStatement|ForStatement'(path) {
        const loop = path as DispatchLoop;
        const body = loop.get('body');
        const forever = t.isWhileStatement(loop.node) ? unconditional(loop.node.test)
          : loop.node.init == null && loop.node.update == null
            && (loop.node.test == null || unconditional(loop.node.test));
        if (!forever || !body.isBlockStatement()) return;
        const statements = body.node.body;
        if (statements.length !== 2) return;
        const [dispatch, exit] = statements;
        if (!t.isSwitchStatement(dispatch) || !t.isBreakStatement(exit) || exit.label) return;
        const selection = dispatch.discriminant;
        if (!t.isMemberExpression(selection) || !selection.computed || !t.isIdentifier(selection.object)) return;
        const cursor = selection.property;
        if (!t.isUpdateExpression(cursor, { operator: '++', prefix: false }) || !t.isIdentifier(cursor.argument)) return;
        const dispatchPath = body.get('body')[0];
        if (!dispatchPath?.isSwitchStatement()) return;
        const orderBinding = dispatchPath.scope.getBinding(selection.object.name);
        const cursorBinding = dispatchPath.scope.getBinding(cursor.argument.name);
        if (!orderBinding || !cursorBinding) return;
        // The table must not escape, be modified, or be read elsewhere.
        // Babel also records the declaration itself for var initialized inside an
        // outer loop. Direct preceding initialization is checked separately.
        const orderWrites = orderBinding.constantViolations.filter((write) => write.node !== orderBinding.path.node);
        const cursorWrites = cursorBinding.constantViolations.filter((write) => write.node !== cursorBinding.path.node);
        if (orderWrites.length !== 0
          || orderBinding.referencePaths.length !== 1
          || orderBinding.referencePaths[0]?.node !== selection.object) return;
        if (!t.isNumericLiteral(initializer(cursorBinding, loop), { value: 0 })) return;
        if (cursorWrites.length !== 1
          || cursorWrites[0]?.node !== cursor
          || cursorBinding.referencePaths.length !== 1
          || cursorBinding.referencePaths[0]?.node !== cursor.argument) return;
        const order = literalOrder(initializer(orderBinding, loop));
        if (!order || order.length < 2 || new Set(order).size !== order.length) return;
        const labels = dispatch.cases.map((branch) => literalKey(branch.test));
        if (labels.length !== order.length || labels.some((key) => key === null)
          || new Set(labels).size !== labels.length || order.some((key) => !labels.includes(key))) return;
        // Ordinary commands already in source order are not a reordered dispatch.
        if (order.every((key, index) => key === labels[index])) return;
        if (!dispatch.cases.every((branch) => {
          const tail = branch.consequent.at(-1);
          return t.isContinueStatement(tail) && !tail.label;
        })) return;
        found = true;
        if (!restore) { loop.stop(); return; }
        // Keep var scope. Reject lexical declarations, declarations with Annex B
        // semantics, and non-tail control transfers rather than guessing targets.
        const ordered: t.Statement[] = [];
        let unsafe = false;
        for (const label of order) {
          const branch = dispatch.cases[labels.indexOf(label)];
          if (!branch) return;
          // Preserve cursor progress and table reads before each original case.
          // The extra final read below corresponds to the terminating iteration.
          ordered.push(t.expressionStatement(t.cloneNode(selection, true)));
          for (const statement of branch.consequent.slice(0, -1)) {
            t.traverseFast(statement, (node) => {
              if (t.isBreakStatement(node) || t.isContinueStatement(node)
                || t.isFunctionDeclaration(node) || t.isClassDeclaration(node)
                || (t.isVariableDeclaration(node) && node.kind !== 'var')) unsafe = true;
            });
            ordered.push(t.cloneNode(statement, true));
          }
        }
        if (unsafe || loop.parentPath.isLabeledStatement()) return;
        ordered.push(t.expressionStatement(t.cloneNode(selection, true)));
        loop.replaceWith(t.blockStatement(ordered));
        flattened++;
        loop.skip();
      },
    });
    return { found, code: flattened ? generate(ast).code : source, flattened };
  } catch {
    // Parsing/traversal failure cannot provide new structural evidence.
    return empty;
  }
}
