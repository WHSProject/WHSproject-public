import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { memberPath, rangeOf, statementOf } from '../code-units';
import type { IndexedCallEdge } from './call-graph';
import {
  EVIDENCE_RANK, fileKey, statementKey,
  type DataFlowEdge, type DataFlowEdgeKind, type EvidenceLevel, type FileRef, type InputWitness, type LineRange, type StatementRef,
} from './program-index.contract';
import { compactStatement, type PackageProgramIndex } from './program-index';
import { loadCall, type FileFacts } from './program-parse';

/** Callers followed for one parameter; a function with more callers than this is reported as not fully followed. */
const MAX_CALLERS_PER_PARAMETER = 8;
/** Calls whose result cannot be read from the source. */
const OPAQUE_CALLEES = new Set(['eval', 'Function', 'Proxy', 'Reflect.get', 'Reflect.apply', 'Reflect.construct', 'Reflect.getOwnPropertyDescriptor']);


/** A function this short is shown whole once the flow needs two or more of its statements. */
const SMALL_FUNCTION_LINES = 12;

/**
 * Replaces the statements of a short function (its declaration and its return,
 * say) by the statement that holds the whole function, at the place the first
 * of them had. A longer function keeps only the statements the flow uses.
 */
function wholeSmallFunctions(index: PackageProgramIndex, statements: StatementRef[]): StatementRef[] {
  const result: StatementRef[] = [];
  const replaced = new Set<string>();
  for (const statement of statements) {
    const facts = index.internal.facts.get(fileKey(statement));
    const inside = (symbol: { startLine: number; endLine: number }, item: StatementRef) => (
      fileKey(item) === fileKey(statement) && item.startLine >= symbol.startLine && item.endLine <= symbol.endLine
    );
    // Innermost function that holds the statement, when it is short and the flow uses more of it.
    const holder = [...(facts?.symbols ?? [])].reverse().find((symbol) => symbol.kind !== 'MODULE' && inside(symbol, statement)
      && symbol.endLine - symbol.startLine + 1 <= SMALL_FUNCTION_LINES && statements.filter((item) => inside(symbol, item)).length >= 2);
    const fn = holder ? facts?.functionOfSymbol.get(holder.id) : undefined;
    const whole = fn ? rangeOf(statementOf(fn)?.node) : undefined;
    if (!holder || !whole || whole.endLine - whole.startLine + 1 > SMALL_FUNCTION_LINES) { result.push(statement); continue; }
    if (replaced.has(holder.id)) continue;
    replaced.add(holder.id);
    result.push({ artifactId: statement.artifactId, filePath: statement.filePath, ...whole, ...(holder.name === undefined ? {} : { symbol: holder.name }) });
  }
  return result.filter((item, position) => result.findIndex((other) => statementKey(other) === statementKey(item)) === position);
}

/**
 * The statements a Finding's lines belong to: every outermost statement that
 * starts on one of its lines, else the innermost statement holding them.
 */
const statementPathCache = new WeakMap<FileFacts, Map<string, NodePath[]>>();

export function statementPathsAt(facts: FileFacts, range: LineRange): NodePath[] {
  const key = `${range.startLine}\u0000${range.endLine}`;
  const cached = statementPathCache.get(facts)?.get(key);
  if (cached) return cached;
  const starting: NodePath[] = [];
  let holding: NodePath | undefined;
  facts.program.traverse({
    enter(path) {
      const { loc } = path.node;
      if (!loc) return;
      if (loc.start.line > range.endLine || loc.end.line < range.startLine) { path.skip(); return; }
      if (!path.isStatement() || path.isBlockStatement()) return;
      const whole = statementOf(path);
      const lines = rangeOf(whole?.node);
      if (!whole || !lines) return;
      if (lines.startLine >= range.startLine && lines.startLine <= range.endLine) { starting.push(whole); path.skip(); return; }
      if (lines.startLine <= range.startLine && lines.endLine >= range.endLine) holding = whole;
    },
  });
  const result = starting.length > 0 ? starting : holding ? [holding] : [];
  const byRange = statementPathCache.get(facts) ?? new Map<string, NodePath[]>();
  byRange.set(key, result);
  statementPathCache.set(facts, byRange);
  return result;
}

/**
 * Follows the values a Finding's statement uses back to where they are
 * produced: a variable's initializer and later assignments, an alias, a
 * destructured or static property, a parameter back to the arguments of the
 * calls that reach the function, a call forward into the returns of the
 * function it runs, and an imported name into the module that exports it. A
 * literal, a global, a built-in call and an external module end a flow. A
 * computed property, `this`, `eval`, a `Proxy`, a reflective call, a callee
 * that is not known and a parameter nobody is seen to pass are recorded as
 * unresolved; nothing is assumed about them.
 */
/** The expressions a statement reads; a nested function body is the statement's own code and is read too. */
export function readsOf(statement: NodePath): NodePath[] {
  const reads: NodePath[] = [];
  const collect = (path: NodePath) => {
    if (path.isExpressionStatement()) reads.push(path.get('expression') as NodePath);
    else if (path.isVariableDeclaration()) for (const item of path.get('declarations')) { const init = item.get('init') as NodePath; if (init.node) reads.push(init); }
    else if (path.isReturnStatement() || path.isThrowStatement()) reads.push(path.get('argument') as NodePath);
    else if (path.isExportNamedDeclaration() || path.isExportDefaultDeclaration()) collect(path.get('declaration') as NodePath);
    else if (path.isIfStatement() || path.isWhileStatement() || path.isDoWhileStatement()) reads.push(path.get('test') as NodePath);
    else if (path.isExpression()) reads.push(path);
  };
  collect(statement);
  return reads;
}

/** The exact call that entered a function holding a value origin. */
export interface ValueOriginEntry { functionId: string; call: IndexedCallEdge }

/** A value to trace instead of everything the Finding's statements read: an argument of a sink call, say. */
export interface ValueOrigin { expression: NodePath; facts: FileFacts; at: StatementRef; entry?: ValueOriginEntry }

export function findInputWitness(index: PackageProgramIndex, file: FileRef, range: LineRange, origins?: readonly ValueOrigin[]): InputWitness {
  const facts = index.internal.facts.get(fileKey(file));
  const starts = facts ? statementPathsAt(facts, range) : [];
  const startRange = rangeOf(starts[0]?.node);
  const finding: StatementRef = { ...file, startLine: startRange?.startLine ?? range.startLine, endLine: rangeOf(starts.at(-1)?.node)?.endLine ?? range.endLine };
  const witness: InputWitness = {
    status: 'NONE', finding, edges: [], statements: [], unresolved: [], limitations: [], exploredDepth: 0, probableEdgeCount: 0, conditional: { eligible: false, reason: 'NO_PROBABLE_EDGE' },
  };
  if (!facts || starts.length === 0) {
    witness.status = 'INCOMPLETE';
    witness.limitations.push('FILE_NOT_INDEXED');
    return witness;
  }
  const { values } = index.internal;
  const { limits } = index;
  // The Finding's own statements are where the flow ends; they are not part of what leads to it.
  const own = starts.flatMap((path) => { const lines = rangeOf(path.node); return lines ? [{ ...file, ...lines }] : []; });
  const seenStatements = new Set<string>([...own, ...(origins ?? []).map((origin) => origin.at)].map(statementKey));
  const seenBindings = new Set<string>();
  const seenFunctions = new Set<string>();
  let visits = 0;
  const deadline = Date.now() + limits.witnessSearchTimeoutMs;

  const limitation = (name: string) => { if (!witness.limitations.includes(name)) witness.limitations.push(name); };
  const refOf = (owner: FileFacts, path: NodePath, name?: string): StatementRef | undefined => {
    const lines = rangeOf(statementOf(path)?.node);
    return lines ? { ...owner.ref, ...lines, ...(name === undefined ? {} : { symbol: name }) } : undefined;
  };
  const addStatement = (statement: StatementRef | undefined) => {
    const item = statement ? compactStatement(index, statement) : undefined;
    if (!item || seenStatements.has(statementKey(item))) return;
    seenStatements.add(statementKey(item));
    witness.statements.push(item);
  };
  const edge = (kind: DataFlowEdgeKind, from: StatementRef | undefined, to: StatementRef, evidence: EvidenceLevel = 'CONFIRMED', name?: string, reason?: string) => {
    const record: DataFlowEdge = { kind, to, evidence, ...(from === undefined ? {} : { from }),
      ...(name === undefined ? {} : { name }), ...(reason === undefined ? {} : { unresolvedReason: reason }) };
    witness.edges.push(record);
    index.dataFlow.push(record);
    addStatement(from);
  };
  const unresolvedAt = (at: StatementRef, reason: string, name?: string) => {
    if (!witness.unresolved.some((item) => item.reason === reason && statementKey(item.at) === statementKey(at))) witness.unresolved.push({ at, reason });
    const record: DataFlowEdge = { kind: 'UNRESOLVED', to: at, evidence: 'UNRESOLVED', unresolvedReason: reason, ...(name === undefined ? {} : { name }) };
    witness.edges.push(record);
    index.dataFlow.push(record);
  };
  // A flow of confirmed edges is followed for `maxDataFlowDepth` steps; once it holds a probable edge, for `maxProbableDepth`.
  const budget = (depth: number, at: StatementRef): boolean => {
    visits += 1;
    const probable = witness.edges.some((item) => item.evidence === 'PROBABLE');
    if (depth > (probable ? limits.maxProbableDepth : limits.maxDataFlowDepth)) { limitation('DEPTH_LIMIT'); unresolvedAt(at, 'DEPTH_LIMIT'); return false; }
    if (visits > limits.maxVisitedSymbols) { limitation('VISITED_SYMBOL_LIMIT'); return false; }
    if (Date.now() > deadline) { limitation('SEARCH_TIMEOUT'); return false; }
    witness.exploredDepth = Math.max(witness.exploredDepth, depth);
    return true;
  };
  /** The argument call a parameter is read from, when the function was entered through one particular call. */
  type Entry = ValueOriginEntry;

  const functionOf = (_owner: FileFacts, path: NodePath): NodePath<t.Function> | null => path.getFunctionParent();
  const notData = (path: NodePath, owner: FileFacts): boolean => {
    const value = values.expression(path, owner).value;
    // An instance made from a dependency's class still carries what it was built from.
    if (value.kind === 'EXTERNAL') return value.member?.includes('()') !== true;
    return ['FUNCTION', 'CLASS', 'MODULE', 'EMITTER'].includes(value.kind);
  };

  type Keys = readonly string[];
  const literalKey = (node: t.Node | null | undefined): string | undefined => (
    t.isStringLiteral(node) ? node.value : t.isNumericLiteral(node) ? String(node.value)
      : t.isTemplateLiteral(node) && node.expressions.length === 0 ? node.quasis[0]?.value.cooked ?? undefined : undefined
  );
  /** A key that is fixed in the source: a name, a literal, or a `const` that is bound once to a literal. */
  const keyOf = (node: t.Node, computed: boolean, scope: NodePath['scope']): string | undefined => {
    if (!computed && t.isIdentifier(node)) return node.name;
    const direct = literalKey(node);
    if (direct !== undefined || !computed || !t.isIdentifier(node)) return direct;
    const binding = scope.getBinding(node.name);
    if (!binding || binding.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return undefined;
    return literalKey(binding.path.node.init);
  };
  /** `root.a[0].b` as its root and ['a', '0', 'b']; undefined when a key is computed. */
  const chainOf = (path: NodePath): { root: NodePath; keys: string[] } | undefined => {
    const keys: string[] = [];
    let current = path;
    while (current.isMemberExpression() || current.isOptionalMemberExpression()) {
      const key = keyOf(current.node.property, current.node.computed, current.scope);
      if (key === undefined) return undefined;
      keys.unshift(key);
      current = current.get('object') as NodePath;
    }
    return { root: current, keys };
  };
  /** Where a name sits in a destructuring pattern, with the default values on the way. */
  type Located = { keys: string[]; defaults: NodePath[] } | 'DYNAMIC' | undefined;
  const locate = (pattern: NodePath, identifier: t.Node): Located => {
    if (pattern.node === identifier) return { keys: [], defaults: [] };
    if (pattern.isAssignmentPattern()) {
      const inner = locate(pattern.get('left') as NodePath, identifier);
      return inner && inner !== 'DYNAMIC' ? { keys: inner.keys, defaults: [pattern.get('right') as NodePath, ...inner.defaults] } : inner;
    }
    if (pattern.isRestElement()) return locate(pattern.get('argument') as NodePath, identifier);
    if (pattern.isObjectPattern()) {
      for (const property of pattern.get('properties')) {
        if (property.isRestElement()) { const rest = locate(property, identifier); if (rest) return rest; continue; }
        if (!property.isObjectProperty()) continue;
        const inner = locate(property.get('value') as NodePath, identifier);
        if (!inner) continue;
        const key = keyOf(property.node.key, property.node.computed, property.scope);
        return key === undefined || inner === 'DYNAMIC' ? 'DYNAMIC' : { keys: [key, ...inner.keys], defaults: inner.defaults };
      }
    }
    if (pattern.isArrayPattern()) {
      for (const [position, element] of (pattern.get('elements') as NodePath[]).entries()) {
        if (!element.node) continue;
        const inner = locate(element, identifier);
        if (!inner) continue;
        if (element.isRestElement()) return inner;
        return inner === 'DYNAMIC' ? inner : { keys: [String(position), ...inner.keys], defaults: inner.defaults };
      }
    }
    return undefined;
  };

  const traceReturns = (symbolId: string, to: StatementRef, depth: number, entry: Entry | undefined, evidence: EvidenceLevel, keys: Keys = []): void => {
    const symbol = index.symbols.get(symbolId);
    const owner = symbol ? index.internal.facts.get(fileKey(symbol)) : undefined;
    const fn = owner?.functionOfSymbol.get(symbolId);
    if (!symbol || !owner || !fn) { unresolvedAt(to, 'CALLEE_NOT_INDEXED'); return; }
    const key = `${symbolId}\u0000${entry?.call.site.startLine ?? ''}\u0000${keys.join('.')}`;
    if (seenFunctions.has(key)) return;
    seenFunctions.add(key);
    const body = fn.get('body') as NodePath;
    if (!body.isBlockStatement()) {
      const from = refOf(owner, fn, symbol.name);
      edge('RETURN', from, to, evidence, symbol.name);
      if (from) traceExpression(body, owner, from, depth + 1, entry, keys);
      return;
    }
    fn.traverse({
      Function(inner) { inner.skip(); },
      ReturnStatement(statement) {
        const argument = statement.get('argument') as NodePath;
        const from = refOf(owner, statement, symbol.name);
        if (!argument.node || !from) return;
        edge('RETURN', from, to, evidence, symbol.name);
        if (symbol.header) addStatement({ ...owner.ref, ...symbol.header, ...(symbol.name === undefined ? {} : { symbol: symbol.name }) });
        traceExpression(argument, owner, from, depth + 1, entry, keys);
      },
    });
  };

  const traceParameter = (binding: Binding, owner: FileFacts, to: StatementRef, depth: number, entry: Entry | undefined, keys: Keys): void => {
    const fn = binding.scope.path as NodePath<t.Function>;
    const symbol = owner.symbolOfFunction.get(fn.node);
    const patterns = fn.get('params') as NodePath[];
    const position = patterns.findIndex((pattern) => locate(pattern, binding.identifier) !== undefined);
    if (!symbol || position < 0) { unresolvedAt(to, 'PARAMETER_NOT_LOCATED', binding.identifier.name); return; }
    if (patterns[position]!.isRestElement()) { unresolvedAt(to, 'REST_PARAMETER', binding.identifier.name); return; }
    const located = locate(patterns[position]!, binding.identifier);
    const header: StatementRef = { ...owner.ref, ...(symbol.header ?? { startLine: symbol.startLine, endLine: symbol.startLine }), ...(symbol.name === undefined ? {} : { symbol: symbol.name }) };
    addStatement(header);
    if (!located || located === 'DYNAMIC') { unresolvedAt(header, 'DESTRUCTURING_NOT_STATIC', binding.identifier.name); return; }
    for (const fallback of located.defaults) traceExpression(fallback, owner, header, depth + 1, undefined);
    const flowing = [...located.keys, ...keys];
    const incoming = index.reverseCalls.get(symbol.id) ?? [];
    const callers = entry?.functionId === symbol.id ? [entry.call] : incoming.filter((item) => item.invocation !== undefined);
    if (callers.length === 0) {
      // A `.then(value => …)` callback receives what its promise resolves to.
      const promise = incoming.find((item) => item.callbackKind === 'PROMISE_MICROTASK' && item.registration !== undefined && position === 0);
      const receiver = promise?.registration ? (promise.registration.path.get('callee') as NodePath) : undefined;
      if (promise?.registration && receiver?.isMemberExpression()) {
        edge('PROMISE_RESULT', promise.site, header, EVIDENCE_RANK[promise.evidence] > EVIDENCE_RANK.PROBABLE ? 'PROBABLE' : promise.evidence, binding.identifier.name);
        traceExpression(receiver.get('object') as NodePath, promise.registration.file, promise.site, depth + 1, undefined);
        return;
      }
      unresolvedAt(header, incoming.length > 0 ? 'CALLBACK_ARGUMENT_FROM_RUNTIME' : 'NO_CALLER_FOUND', binding.identifier.name);
      return;
    }
    if (callers.length > MAX_CALLERS_PER_PARAMETER) limitation('CALLER_LIMIT');
    for (const caller of callers.slice(0, MAX_CALLERS_PER_PARAMETER)) {
      const { invocation } = caller;
      if (!invocation) continue;
      const argument = (invocation.path.get('arguments') as NodePath[])[position + invocation.argumentOffset];
      const site = refOf(invocation.file, invocation.path) ?? caller.site;
      if (!argument?.node) continue;
      if (argument.isSpreadElement()) { unresolvedAt(site, 'SPREAD_ARGUMENT', binding.identifier.name); continue; }
      edge(caller.kind === 'CALLBACK' ? 'CALLBACK_ARGUMENT' : 'ARGUMENT_TO_PARAMETER', site, header, caller.evidence, binding.identifier.name);
      for (const link of caller.links) addStatement(link);
      traceExpression(argument, invocation.file, site, depth + 1, undefined, flowing);
    }
  };

  /** The value an imported name stands for, followed into the module that exports it. */
  const traceExport = (target: FileFacts, name: string, from: StatementRef, depth: number, keys: Keys = []): void => {
    const definition = name === 'default' ? target.exports.default : target.exports.named.get(name);
    if (!definition) {
      const whole = target.exports.default?.value;
      if (name !== 'default' && whole && !target.program.node.body.some((item) => t.isExportDefaultDeclaration(item))) {
        // `module.exports = { name }` or `module.exports = object`.
        const at = { ...target.ref, ...target.exports.default!.statement };
        edge('IMPORT_EXPORT', at, from, 'CONFIRMED', name);
        traceExpression(whole, target, at, depth + 1, undefined, [name, ...keys]);
        return;
      }
      unresolvedAt(from, 'EXPORT_NOT_FOUND', name);
      return;
    }
    const at: StatementRef = { ...target.ref, ...definition.statement };
    edge('IMPORT_EXPORT', at, from, 'CONFIRMED', name);
    if (definition.reexport) {
      const next = index.internal.values.input.reexports.get(`${fileKey(target.ref)}\u0000${definition.reexport.specifier}`);
      const nextFile = next?.resolution === 'RESOLVED' && next.to ? index.internal.facts.get(fileKey(next.to)) : undefined;
      if (!nextFile || definition.reexport.name === '*') { if (!nextFile) unresolvedAt(at, 'REEXPORT_TARGET_UNRESOLVED', name); return; }
      traceExport(nextFile, definition.reexport.name, at, depth + 1, keys);
    } else if (definition.value) traceExpression(definition.value, target, at, depth + 1, undefined, keys);
    else if (definition.localName !== undefined) {
      const binding = target.program.scope.getBinding(definition.localName);
      if (binding) traceBinding(binding, target, at, depth + 1, undefined, undefined, keys);
      else unresolvedAt(at, 'EXPORT_LOCAL_NOT_FOUND', name);
    }
  };

  const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
  const NON_MUTATING_CALLEES = /^(?:JSON\.stringify|console\.\w+|Object\.(?:keys|values|entries|freeze|isFrozen)|String|Number|Boolean|Array\.isArray|util\.inspect)$/u;
  const isBranching = (path: NodePath): boolean => path.isIfStatement() || path.isConditionalExpression() || path.isLogicalExpression()
    || path.isLoop() || path.isTryStatement() || path.isSwitchStatement() || path.isCatchClause();
  /** Whether code at `node`, earlier in the same function, has run whenever `use` runs. */
  const reaches = (node: NodePath, use: NodePath): 'ALWAYS' | 'MAYBE' | 'NEVER' => {
    let result: 'ALWAYS' | 'MAYBE' = 'ALWAYS';
    for (let current = node; current.parentPath && !current.parentPath.isFunction() && !current.parentPath.isProgram(); current = current.parentPath) {
      const parent = current.parentPath;
      if (!isBranching(parent)) continue;
      const shared = use.isDescendant(parent);
      if (parent.isIfStatement() || parent.isConditionalExpression()) {
        if (current.key === 'test') continue;
        const branch = shared ? use.find((item) => item.parentPath === parent)?.key : undefined;
        if (shared && branch !== current.key) return 'NEVER';
        if (!shared) result = 'MAYBE';
      } else if (parent.isLogicalExpression()) {
        if (current.key === 'right' && !shared) result = 'MAYBE';
      } else if (!shared) result = 'MAYBE';
    }
    return result;
  };
  const functionSymbol = (owner: FileFacts, path: NodePath): string => {
    const fn = path.getFunctionParent();
    return (fn && owner.symbolOfFunction.get(fn.node)?.id) ?? owner.module.id;
  };

  interface PropertyWrite { at: StatementRef; value: NodePath; rest: Keys; name: string; holder: NodePath }
  /**
   * What is written into `binding` under `keys`: `x.a.b = v`, `Object.assign(x, v)`. With a known use site, only
   * the last write that has always run before it counts; a write on one branch, in a loop or in another function
   * is probable, and so is everything once the object was handed to code that may change it.
   */
  const traceWrites = (
    binding: Binding, owner: FileFacts, to: StatementRef, depth: number, entry: Entry | undefined, keys: Keys, use: NodePath | undefined,
  ): { superseded: boolean; initial: EvidenceLevel } => {
    const name = binding.identifier.name;
    const usePosition = use?.node.start ?? undefined;
    const useFunction = use?.getFunctionParent() ?? null;
    const sameFunction = (path: NodePath): boolean => use !== undefined && path.getFunctionParent() === useFunction;
    const before = (path: NodePath): boolean => usePosition === undefined || !sameFunction(path) || (path.node.start ?? 0) < usePosition;
    const writes: PropertyWrite[] = [];
    for (const reference of binding.referencePaths) {
      let top: NodePath = reference;
      const written: string[] = [];
      let dynamic = false;
      while (top.parentPath && (top.parentPath.isMemberExpression() || top.parentPath.isOptionalMemberExpression()) && top.parentPath.node.object === top.node) {
        const key = keyOf(top.parentPath.node.property, top.parentPath.node.computed, top.parentPath.scope);
        if (key === undefined) dynamic = true;
        else written.push(key);
        top = top.parentPath;
      }
      const user = top.parentPath;
      const at = refOf(owner, reference, name);
      if (!user || !at) continue;
      if (user.isAssignmentExpression() && user.node.left === top.node) {
        if (!before(user)) continue;
        // A write under a key that is only known at run time may be the one that is read.
        if (dynamic) { unresolvedAt(at, 'COMPUTED_PROPERTY', name); continue; }
        if (written.includes('__proto__') || written.includes('prototype')) { unresolvedAt(at, 'PROTOTYPE_MUTATION', name); continue; }
        const shared = Math.min(written.length, keys.length);
        if (written.length === 0 || !written.slice(0, shared).every((key, position) => key === keys[position])) continue;
        writes.push({ at, value: user.get('right') as NodePath, rest: keys.slice(shared), name: written.join('.'), holder: user });
      } else if (user.isCallExpression() && top === reference) {
        const callee = memberPath(user.node.callee)?.join('.');
        const first = user.node.arguments[0] === reference.node;
        if (callee === 'Object.setPrototypeOf' && first) unresolvedAt(at, 'PROTOTYPE_MUTATION', name);
        else if (callee === 'Object.assign' && first && before(user)) {
          for (const source of (user.get('arguments') as NodePath[]).slice(1)) writes.push({ at, value: source, rest: keys, name, holder: user });
        }
      } else if (written.length === 1 && ARRAY_MUTATORS.has(written[0]!) && top.parentPath?.isCallExpression() && /^\d+$/u.test(keys[0] ?? '') && before(top.parentPath)) {
        // After a push, a splice or a sort, which element sits at a fixed index is not known.
        unresolvedAt(at, 'ARRAY_MUTATION', name);
      }
    }
    const emit = (write: PropertyWrite, evidence: EvidenceLevel, reason?: string) => {
      edge('PROPERTY_WRITE', write.at, to, evidence, write.name, reason);
      traceExpression(write.value, owner, write.at, depth + 1, entry, write.rest);
    };
    if (!use || usePosition === undefined) {
      for (const write of writes) emit(write, 'CONFIRMED');
      return { superseded: false, initial: 'CONFIRMED' };
    }

    /** The object was handed, between `from` and the use, to code that may change it. */
    const escaped = (from: number): boolean => binding.referencePaths.some((reference) => {
      const call = reference.parentPath;
      const position = reference.node.start ?? 0;
      if (!sameFunction(reference) || position <= from || position >= usePosition) return false;
      if (!(call?.isCallExpression() || call?.isNewExpression()) || !(call.node.arguments as t.Node[]).includes(reference.node)) return false;
      const callee = memberPath(call.node.callee)?.join('.');
      return callee === undefined || (callee !== 'Object.assign' && !NON_MUTATING_CALLEES.test(callee));
    });
    const always: Array<PropertyWrite & { position: number }> = [];
    const maybe: Array<PropertyWrite & { position: number; reason: string }> = [];
    for (const write of writes) {
      const position = write.holder.node.start ?? 0;
      if (sameFunction(write.holder)) {
        const reach = reaches(write.holder, use);
        if (reach === 'ALWAYS') always.push({ ...write, position });
        else if (reach === 'MAYBE') maybe.push({ ...write, position, reason: 'WRITE_ON_SOME_PATHS' });
        continue;
      }
      // A write in another function counts as made when this function calls that function, always, before the use.
      const writer = functionSymbol(owner, write.holder);
      const call = index.calls.find((item) => item.calleeId === writer && item.callerId === functionSymbol(owner, use) && item.kind === 'CALL' && item.evidence === 'CONFIRMED'
        && item.invocation !== undefined && sameFunction(item.invocation.path) && (item.invocation.path.node.start ?? 0) < usePosition && reaches(item.invocation.path, use) === 'ALWAYS');
      if (call?.invocation) always.push({ ...write, position: call.invocation.path.node.start ?? 0 });
      else maybe.push({ ...write, position: -1, reason: 'WRITE_IN_ANOTHER_FUNCTION' });
    }
    always.sort((left, right) => left.position - right.position);
    const last = always.at(-1);
    const open = maybe.filter((write) => !last || write.position < 0 || write.position > last.position);
    if (open.length === 0) {
      if (!last) {
        const declared = binding.path.node.start ?? 0;
        return { superseded: false, initial: sameFunction(binding.path) && escaped(declared) ? 'PROBABLE' : 'CONFIRMED' };
      }
      const leaked = escaped(last.position);
      emit(last, leaked ? 'PROBABLE' : 'CONFIRMED', leaked ? 'OBJECT_ESCAPED' : undefined);
      return { superseded: true, initial: 'CONFIRMED' };
    }
    // Both branches of one `if` writing the same value leave no doubt about what is read.
    const [first, second] = open;
    const branchOf = (write: PropertyWrite) => write.holder.findParent((item) => item.parentPath?.isIfStatement() === true && (item.key === 'consequent' || item.key === 'alternate'));
    const sameIf = open.length === 2 && branchOf(first!) && branchOf(second!) && branchOf(first!)!.parentPath === branchOf(second!)!.parentPath && branchOf(first!)!.key !== branchOf(second!)!.key;
    const text = (write: PropertyWrite) => owner.code.slice(write.value.node.start ?? 0, write.value.node.end ?? 0);
    if (sameIf && text(first!) === text(second!) && first!.rest.join('.') === second!.rest.join('.')) {
      const leaked = escaped(Math.max(first!.position, second!.position));
      emit(first!, leaked ? 'PROBABLE' : 'CONFIRMED', leaked ? 'OBJECT_ESCAPED' : undefined);
      addStatement(second!.at);
      return { superseded: true, initial: 'CONFIRMED' };
    }
    for (const write of open) emit(write, 'PROBABLE', write.reason);
    // One of the two branches always runs, so what was there before is overwritten either way.
    if (sameIf) return { superseded: true, initial: 'PROBABLE' };
    if (last) emit(last, 'PROBABLE', 'WRITE_ON_SOME_PATHS');
    return { superseded: last !== undefined, initial: 'PROBABLE' };
  };

  const traceBinding = (
    binding: Binding, owner: FileFacts, to: StatementRef, depth: number, entry: Entry | undefined, usedIn?: NodePath<t.Function> | null, keys: Keys = [], use?: NodePath,
  ): void => {
    if (!budget(depth, to)) return;
    const key = `${fileKey(owner.ref)}\u0000${binding.identifier.start ?? ''}\u0000${binding.identifier.name}\u0000${entry?.call.site.startLine ?? ''}\u0000${keys.join('.')}`;
    if (seenBindings.has(key)) return;
    seenBindings.add(key);
    const name = binding.identifier.name;
    const { path } = binding;
    if (binding.kind === 'param') { traceParameter(binding, owner, to, depth, entry, keys); return; }
    if (path.isFunctionDeclaration() || path.isClassDeclaration()) return;

    if (path.isImportSpecifier() || path.isImportDefaultSpecifier() || path.isImportNamespaceSpecifier()) {
      const declaration = path.parentPath;
      const at = refOf(owner, declaration as NodePath, name);
      if (!at) return;
      edge('IMPORT_EXPORT', at, to, 'CONFIRMED', name);
      const target = values.moduleOf(declaration!.node);
      if (!target) { if (values.externalOf(declaration!.node) === undefined) unresolvedAt(at, 'IMPORT_TARGET_UNRESOLVED', name); return; }
      if (path.isImportNamespaceSpecifier()) { if (keys.length > 0) traceExport(target, keys[0]!, at, depth + 1, keys.slice(1)); return; }
      const imported = path.isImportDefaultSpecifier() ? 'default'
        : t.isIdentifier((path.node as t.ImportSpecifier).imported) ? ((path.node as t.ImportSpecifier).imported as t.Identifier).name
          : ((path.node as t.ImportSpecifier).imported as t.StringLiteral).value;
      traceExport(target, imported, at, depth + 1, keys);
      return;
    }

    if (path.isVariableDeclarator()) {
      const at = refOf(owner, path, name);
      if (!at) return;
      const declaredIn = path.getFunctionParent();
      const closure = usedIn !== undefined && declaredIn !== null && declaredIn !== usedIn;
      const init = path.get('init') as NodePath;
      const located = locate(path.get('id') as NodePath, binding.identifier);
      const loop = path.parentPath?.parentPath;
      const written = keys.length > 0 ? traceWrites(binding, owner, to, depth, entry, keys, use) : { superseded: false, initial: 'CONFIRMED' as const };
      // An object that is assigned again may no longer hold what was put into it.
      const evidence: EvidenceLevel = keys.length > 0 && !binding.constant ? 'PROBABLE' : written.initial;
      if (!located || located === 'DYNAMIC') {
        unresolvedAt(at, 'DESTRUCTURING_NOT_STATIC', name);
      } else if (!init.node && (loop?.isForOfStatement() || loop?.isForInStatement())) {
        edge('INITIALIZER', at, to, 'CONFIRMED', name);
        traceExpression(loop.get('right') as NodePath, owner, at, depth + 1, entry);
      } else if (init.node && !written.superseded) {
        const flowing = [...located.keys, ...keys];
        const kind = located.keys.length > 0 ? 'DESTRUCTURING' : keys.length > 0 ? 'PROPERTY_READ' : closure ? 'CLOSURE' : init.isIdentifier() ? 'ALIAS' : 'INITIALIZER';
        edge(kind, at, to, evidence, keys.length > 0 && located.keys.length === 0 ? keys.join('.') : name);
        for (const fallback of located.defaults) traceExpression(fallback, owner, at, depth + 1, entry);
        const load = init.isCallExpression() ? loadCall(init) : undefined;
        const target = load ? values.moduleOf(init.node) : undefined;
        if (load && target && flowing.length > 0) traceExport(target, flowing[0]!, at, depth + 1, flowing.slice(1));
        else if (load && !target) { if (values.externalOf(init.node) === undefined) unresolvedAt(at, 'IMPORT_TARGET_UNRESOLVED', name); }
        else if (!load) traceExpression(init, owner, at, depth + 1, entry, flowing);
      }
      for (const violation of binding.constantViolations) {
        const assigned = refOf(owner, violation, name);
        if (!assigned) continue;
        if (violation.isAssignmentExpression() && t.isIdentifier(violation.node.left)) {
          edge('ASSIGNMENT', assigned, to, 'CONFIRMED', name);
          traceExpression(violation.get('right') as NodePath, owner, assigned, depth + 1, entry, keys);
        } else if (!violation.isUpdateExpression() && violation.node !== path.node) unresolvedAt(assigned, 'COMPLEX_ASSIGNMENT', name);
      }
      return;
    }
    unresolvedAt(to, 'UNSUPPORTED_BINDING', name);
  };

  const traceExpression = (path: NodePath, owner: FileFacts, to: StatementRef, depth: number, entry: Entry | undefined, keys: Keys = []): void => {
    if (!path.node || !budget(depth, to)) return;
    const again = (child: NodePath | null | undefined, under: Keys = []) => { if (child?.node) traceExpression(child, owner, to, depth, entry, under); };
    if (path.isLiteral() && !path.isTemplateLiteral()) return;
    if (path.isFunction() || path.isClass()) return;
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      // A name for a function, a class or a module is not a value that flows in.
      if (binding && !notData(path, owner)) traceBinding(binding, owner, to, depth, entry, functionOf(owner, path), keys, path);
      return;
    }
    if (path.isTemplateLiteral()) { for (const item of path.get('expressions')) again(item as NodePath); return; }
    if (path.isBinaryExpression()) { again(path.get('left') as NodePath); again(path.get('right') as NodePath); return; }
    if (path.isLogicalExpression()) { again(path.get('left') as NodePath, keys); again(path.get('right') as NodePath, keys); return; }
    if (path.isConditionalExpression()) { again(path.get('consequent'), keys); again(path.get('alternate'), keys); return; }
    if (path.isAwaitExpression()) { again(path.get('argument') as NodePath, keys); return; }
    if (path.isUnaryExpression() || path.isSpreadElement() || path.isYieldExpression()) { again(path.get('argument') as NodePath); return; }
    if (path.isSequenceExpression()) { again(path.get('expressions').at(-1), keys); return; }
    if (path.isAssignmentExpression()) { again(path.get('right'), keys); return; }
    if (t.isTSAsExpression(path.node) || t.isTSNonNullExpression(path.node) || t.isTSSatisfiesExpression(path.node) || t.isParenthesizedExpression(path.node) || t.isTSTypeAssertion(path.node)) {
      again(path.get('expression') as NodePath, keys);
      return;
    }
    if (path.isArrayExpression()) {
      const elements = path.get('elements') as NodePath[];
      const position = /^\d+$/u.test(keys[0] ?? '') ? Number(keys[0]) : undefined;
      // A fixed index picks its element unless a spread before it shifts the positions.
      if (position !== undefined && !elements.slice(0, position + 1).some((item) => item.isSpreadElement())) { again(elements[position], keys.slice(1)); return; }
      for (const item of elements) again(item.isSpreadElement() ? item.get('argument') as NodePath : item);
      return;
    }
    if (path.isObjectExpression()) {
      for (const item of path.get('properties')) {
        if (item.isSpreadElement()) { again(item.get('argument'), keys); continue; }
        const member = item.node as t.ObjectProperty | t.ObjectMethod;
        const name = keyOf(member.key, member.computed === true, item.scope);
        if (name === undefined) { unresolvedAt(to, 'COMPUTED_PROPERTY'); continue; }
        if (keys.length > 0 && name !== keys[0]) continue;
        if (item.isObjectProperty()) again(item.get('value') as NodePath, keys.slice(1));
      }
      return;
    }
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const chain = chainOf(path);
      if (!chain) { unresolvedAt(to, 'COMPUTED_PROPERTY'); return; }
      const { root } = chain;
      const flowing = [...chain.keys, ...keys];
      if (root.isThisExpression()) {
        // A field the class fills in one place: the value is what that assignment puts there.
        const holder = values.classOfThis(root);
        const held = holder && flowing.length > 0 ? values.fieldValue(holder, flowing[0]!) : undefined;
        const at = held ? refOf(owner, held, `this.${flowing[0]}`) : undefined;
        if (!held || !at) { unresolvedAt(to, 'THIS_PROPERTY'); return; }
        edge('ASSIGNMENT', at, to, 'CONFIRMED', `this.${flowing[0]}`);
        traceExpression(held, owner, at, depth + 1, undefined, flowing.slice(1));
        return;
      }
      if (!root.isIdentifier()) { again(root, flowing); return; }
      const binding = root.scope.getBinding(root.node.name);
      // An unbound root is a global (`process.env.TOKEN`): a direct source.
      if (!binding) return;
      const resolved = values.expression(root, owner);
      if (resolved.value.kind === 'MODULE') {
        // `config.token` of a module of the package: the value is what that module exports under the name.
        for (const link of resolved.links) addStatement(link);
        traceExport(resolved.value.file, flowing[0]!, to, depth + 1, flowing.slice(1));
        return;
      }
      if (!notData(root, owner)) traceBinding(binding, owner, to, depth, entry, functionOf(owner, path), flowing, path);
      return;
    }
    if (path.isCallExpression() || path.isNewExpression() || path.isOptionalCallExpression()) {
      const callee = path.get('callee') as NodePath;
      const args = path.get('arguments') as NodePath[];
      const calleeName = memberPath(callee.node)?.join('.');
      if (path.isCallExpression() && loadCall(path)) {
        const target = values.moduleOf(path.node);
        if (target && keys.length > 0) traceExport(target, keys[0]!, to, depth + 1, keys.slice(1));
        else if (!target && values.externalOf(path.node) === undefined) unresolvedAt(to, 'IMPORT_TARGET_UNRESOLVED');
        return;
      }
      if (calleeName !== undefined && OPAQUE_CALLEES.has(calleeName) && !path.scope.getBinding(calleeName.split('.')[0]!)) { unresolvedAt(to, 'DYNAMIC_EVALUATION'); return; }
      const call = path as NodePath<t.CallExpression | t.NewExpression>;
      const resolved = values.expression(callee, owner);
      if (resolved.value.kind === 'FUNCTION') {
        const symbolId = resolved.value.symbol.id;
        const known = (index.reverseCalls.get(symbolId) ?? []).find((item) => item.invocation?.path.node === call.node);
        for (const link of resolved.links) addStatement(link);
        traceReturns(symbolId, to, depth, known ? { functionId: symbolId, call: known } : undefined, resolved.evidence, keys);
        return;
      }
      if (resolved.value.kind === 'UNRESOLVED' && ['PARAMETER', 'COMPUTED_PROPERTY', 'ALIAS_DEPTH', 'IMPORT_TARGET_UNRESOLVED', 'EXPORT_NOT_FOUND', 'THIS'].includes(resolved.value.reason)) {
        unresolvedAt(to, `CALLEE_${resolved.value.reason}`);
        return;
      }
      if (resolved.value.kind === 'CLASS' || resolved.value.kind === 'INSTANCE'
        || resolved.value.kind === 'OBJECT' || resolved.value.kind === 'MODULE') { unresolvedAt(to, 'CALL_RESULT_NOT_FOLLOWED'); return; }
      // A global or built-in call is a direct source; what it is given, and the value a method is called on, still flow into it.
      if (callee.isMemberExpression()) again(callee.get('object') as NodePath);
      for (const argument of args) again(argument);
      return;
    }
    if (path.isUpdateExpression()) { again(path.get('argument') as NodePath); return; }
    if (path.isTaggedTemplateExpression()) { again(path.get('quasi') as NodePath); return; }
    unresolvedAt(to, 'UNSUPPORTED_EXPRESSION');
  };

  if (origins) {
    for (const origin of origins) if (origin.expression.node) traceExpression(origin.expression, origin.facts, origin.at, 0, origin.entry);
  } else {
    for (const [position, start] of starts.entries()) {
      for (const read of readsOf(start)) if (read.node) traceExpression(read, facts, own[position] ?? finding, 0, undefined);
    }
  }

  witness.statements = wholeSmallFunctions(index, witness.statements);
  const traced = witness.edges.filter((item) => item.kind !== 'UNRESOLVED');
  witness.probableEdgeCount = traced.filter((item) => item.evidence === 'PROBABLE').length;
  const blocked = witness.unresolved.length > 0 || witness.limitations.some((name) => name !== 'PROBABLE_EDGE_LIMIT');
  witness.conditional = witness.probableEdgeCount === 0 ? { eligible: false, reason: 'NO_PROBABLE_EDGE' }
    : witness.probableEdgeCount > 1 ? { eligible: false, reason: 'PROBABLE_EDGE_LIMIT' }
      : blocked ? { eligible: false, reason: 'FLOW_NOT_COMPLETE' }
        // The value of a promise that is not shown to settle depends on something outside the code.
        : traced.some((item) => item.kind === 'PROMISE_RESULT' && item.evidence === 'PROBABLE') ? { eligible: false, reason: 'EXCLUDED_STEP:UNCONFIRMED_PROMISE' }
          : { eligible: true, reason: 'ONE_PROBABLE_EDGE' };
  witness.status = witness.edges.length === 0 ? 'NONE'
    : witness.unresolved.length === 0 && witness.limitations.length === 0 && witness.edges.every((item) => EVIDENCE_RANK[item.evidence] <= EVIDENCE_RANK.CONFIRMED_ASYNC) ? 'COMPLETE' : 'INCOMPLETE';
  return witness;
}
