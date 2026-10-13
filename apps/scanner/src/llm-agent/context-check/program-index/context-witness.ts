import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { memberPath, rangeOf, statementOf } from '../code-units';
import type { BehaviorGroup, ContextCode, ContextWitnessPath, WitnessFailureReason } from '../context-check.contract';
import {
  COMPOSITE_ACTION_STAGES, actionFamilyOf, actionGlobalFamilyOf, isActionGlobal, isActionModule, isExternalAction, type ApiFamily,
} from './action-apis';
import type { IndexedCallEdge } from './call-graph';
import { findInputWitness, readsOf, statementPathsAt, type ValueOrigin } from './input-witness';
import { compactStatement, type PackageProgramIndex } from './program-index';
import { fileKey, statementKey, isConfirmed, type EvidenceLevel, type FileRef, type InputWitness, type LineRange, type StatementRef } from './program-index.contract';
import { loadCall, type FileFacts } from './program-parse';

const ENV_READ_BEHAVIORS: readonly BehaviorGroup[] = ['SENSITIVE_READ', 'ENVIRONMENT_READ', 'SYSTEM_DISCOVERY', 'COLLECT_AND_SEND'];
/** Statements that use a read value; a value used in more places is not followed to the end. */
const MAX_READ_USES = 8;
/** How many names or fields a read value is followed through before its uses. */
const MAX_READ_HOPS = 3;
const EXTERNAL_REASONS = new Set(['NO_CALLER_FOUND', 'CALLBACK_ARGUMENT_FROM_RUNTIME', 'IMPORT_TARGET_UNRESOLVED', 'EXPORT_NOT_FOUND', 'REEXPORT_TARGET_UNRESOLVED', 'CALL_RESULT_NOT_FOLLOWED']);
const callEdgeCache = new WeakMap<PackageProgramIndex, Map<t.Node, IndexedCallEdge>>();
const callsByLineCache = new WeakMap<FileFacts, Map<number, Array<NodePath<t.CallExpression | t.NewExpression>>>>();
const actionPathCache = new WeakMap<PackageProgramIndex, Map<string, ContextWitnessPath[]>>();

export interface WitnessTarget { groupId: string; findingId: string; behavior: BehaviorGroup }
type Step = ContextWitnessPath['steps'][number];
interface Sink {
  facts: FileFacts;
  statement: StatementRef;
  call?: NodePath<t.CallExpression | t.NewExpression>;
  /** A read that is not a call, such as `process.env.NAME`. */
  read?: NodePath;
  name?: string;
  /** The exact caller edge used to enter the function that contains this sink. */
  entry?: ValueOrigin['entry'];
  family?: ApiFamily;
}

const LISTENER_MEMBERS = new Set(['on', 'once', 'addListener', 'addEventListener']);

function inlineListenerStatement(path: NodePath, eventName?: string): NodePath | undefined {
  const callback = path.getFunctionParent();
  const registration = callback?.parentPath;
  const member = registration && (registration.isCallExpression() || registration.isNewExpression())
    ? memberPath(registration.node.callee)?.at(-1) : undefined;
  const event = registration && (registration.isCallExpression() || registration.isNewExpression())
    ? registration.node.arguments[0] : undefined;
  return callback && registration && (registration.isCallExpression() || registration.isNewExpression())
    && (registration.node.arguments as t.Node[]).includes(callback.node) && member !== undefined && LISTENER_MEMBERS.has(member)
    && (eventName === undefined || (t.isStringLiteral(event) && event.value === eventName))
    ? statementOf(registration) ?? undefined : undefined;
}

/** A call in an inline listener needs the registration and the entire handler as one syntactic unit. */
function sinkStatement(index: PackageProgramIndex, facts: FileFacts, path: NodePath): StatementRef | undefined {
  const inlineListener = inlineListenerStatement(path);
  const whole = inlineListener ?? statementOf(path);
  const range = rangeOf(whole?.node);
  if (!range) return undefined;
  const statement = { ...facts.ref, ...range };
  return inlineListener ? statement : compactStatement(index, statement);
}

function unique(statements: readonly StatementRef[]): StatementRef[] {
  const seen = new Set<string>();
  const once = statements.filter((item) => (seen.has(statementKey(item)) ? false : (seen.add(statementKey(item)), true)));
  // A statement that lies inside a longer one of the same path (a function shown whole) is not listed again.
  return once.filter((item) => !once.some((other) => other !== item && fileKey(other) === fileKey(item)
    && other.startLine <= item.startLine && other.endLine >= item.endLine && other.endLine - other.startLine > item.endLine - item.startLine));
}

export function pathOf(
  context: ContextCode, target: WitnessTarget, steps: Step[], statements: StatementRef[], failureReason?: WitnessFailureReason, sink?: Sink,
): ContextWitnessPath {
  const probableEdgeCount = steps.filter((step) => step.evidence === 'PROBABLE').length;
  const reason = failureReason;
  return {
    pathId: '', context, groupId: target.groupId, findingId: target.findingId, complete: reason === undefined, steps,
    confirmedEdgeCount: steps.filter((step) => isConfirmed(step.evidence)).length,
    confirmedAsyncEdgeCount: steps.filter((step) => step.evidence === 'CONFIRMED_ASYNC').length, probableEdgeCount, depth: steps.length,
    ...(sink === undefined ? {} : {
      sink: {
        artifactId: sink.statement.artifactId, filePath: sink.statement.filePath, startLine: sink.statement.startLine, endLine: sink.statement.endLine,
        ...(sink.name === undefined ? {} : { callee: sink.name }),
      },
    }),
    statements: unique(statements).map(({ artifactId, filePath, startLine, endLine }) => ({ artifactId, filePath, startLine, endLine })),
    ...(reason === undefined ? {} : { failureReason: reason }), newTargetCount: 0, newLineCount: 0, outcome: 'NOT_NEEDED',
  };
}

/** INPUT, TARGET and LINK share the value tracer; this turns its result into a path. */
export function flowPath(context: ContextCode, target: WitnessTarget, witness: InputWitness, end: StatementRef[] = [], sink?: Sink): ContextWitnessPath {
  const steps: Step[] = witness.edges.filter((edge) => edge.kind !== 'UNRESOLVED')
    .map((edge) => ({ kind: edge.kind, evidence: edge.evidence, basis: edge.kind, statement: edge.from ?? edge.to }));
  const reasons = [...witness.unresolved.map((item) => item.reason), ...witness.limitations];
  const failure: WitnessFailureReason | undefined = reasons.includes('DEPTH_LIMIT') ? 'DEPTH_LIMIT'
    : reasons.some((reason) => EXTERNAL_REASONS.has(reason)) ? 'EXTERNAL_BOUNDARY'
        : witness.unresolved.length > 0 ? 'DYNAMIC_DISPATCH'
          : reasons.length > 0 ? 'NO_COMPLETE_PATH' : undefined;
  return pathOf(context, target, steps, [...witness.statements, ...end], failure, sink);
}

/** Every operation call in the region, one per statement, in source order. */
function sinksAt(index: PackageProgramIndex, facts: FileFacts, region: NodePath, behavior: BehaviorGroup, atFinding: boolean, skipNested: boolean, onlyRegion = false): Sink[] {
  const { values } = index.internal;
  const found: Sink[] = [];
  const seen = new Set<string>();
  const take = (path: NodePath, call?: NodePath<t.CallExpression | t.NewExpression>, family?: ApiFamily) => {
    const statement = sinkStatement(index, facts, path);
    if (!statement) return;
    const name = memberPath(call ? call.node.callee : path.node)?.join('.');
    const key = `${statementKey(statement)}\u0000${name ?? ''}\u0000${call?.node.start ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ facts, statement, ...(call ? { call } : { read: path }), ...(name === undefined ? {} : { name }), ...(family === undefined ? {} : { family }) });
  };
  const visit = (call: NodePath<t.CallExpression | t.NewExpression>) => {
    // The operation of an environment read is the read; a call on the same line is not what the Finding is about.
    if (behavior === 'ENVIRONMENT_READ') return;
    const callee = call.get('callee') as NodePath;
    const resolution = values.expression(callee, facts);
    const { value: resolved } = resolution;
    const factoryIsStatic = resolved.kind !== 'EXTERNAL' || resolved.member?.includes('()') !== true || resolution.evidence === 'CONFIRMED';
    const family = resolved.kind === 'EXTERNAL' && factoryIsStatic ? actionFamilyOf(behavior, resolved.module, resolved.member) : undefined;
    const startsFindingListenerOperation = atFinding && inlineListenerStatement(call, 'readable') !== undefined
      && call.node.loc?.start.line === region.node.loc?.start.line
      && !(call.isCallExpression() && loadCall(call));
    // The analyzer's exact Finding call remains usable even for an unlisted dependency. Deeper calls must match
    // both their statically resolved origin and the central member-level action policy.
    if (startsFindingListenerOperation || (resolved.kind === 'EXTERNAL' && (atFinding || (factoryIsStatic
      && (isActionModule(behavior, resolved.module, resolved.member) || isExternalAction(behavior, resolved.module, resolved.member)))))) { take(call, call, family); return; }
    const name = memberPath(callee.node)?.[0];
    if (name !== undefined && callee.isIdentifier() && !call.scope.getBinding(name) && isActionGlobal(behavior, name)) take(call, call, actionGlobalFamilyOf(behavior, name));
  };
  const visitor = {
    Function(path: NodePath<t.Function>) { if (skipNested) path.skip(); },
    CallExpression: visit,
    NewExpression: visit,
    MemberExpression(path: NodePath<t.MemberExpression>) {
      if (!ENV_READ_BEHAVIORS.includes(behavior)) return;
      const parts = memberPath(path.node);
      if (parts?.[0] === 'process' && parts[1] === 'env' && !path.scope.getBinding('process')) take(path, undefined, 'FILE_READ');
    },
  };
  if (region.isCallExpression() || region.isNewExpression()) visit(region as NodePath<t.CallExpression | t.NewExpression>);
  if (!onlyRegion) region.traverse(visitor);
  return found;
}

/**
 * A Finding on a declaration (`const https = require('https')`, an import, a
 * constant URL) performs nothing itself. The operation is where the declared
 * name is used: as what an operation call is made on, or as its argument.
 */
function sinksUsing(index: PackageProgramIndex, facts: FileFacts, start: NodePath, behavior: BehaviorGroup): Sink[] {
  if (!start.isVariableDeclaration() && !start.isImportDeclaration()) return [];
  const sinks: Sink[] = [];
  for (const name of Object.keys(start.getBindingIdentifiers())) {
    const binding = start.scope.getBinding(name);
    for (const reference of binding?.constant ? binding.referencePaths : []) {
      let top: NodePath = reference;
      while (top.parentPath?.isMemberExpression() && top.parentPath.node.object === top.node) top = top.parentPath;
      const call = top.parentPath;
      if (!call || !(call.isCallExpression() || call.isNewExpression())) continue;
      const used = call.node.callee === top.node || (top === reference && (call.node.arguments as t.Node[]).includes(reference.node));
      if (used) sinks.push(...sinksAt(index, facts, call, behavior, false, true, true));
    }
  }
  return sinks;
}

interface ActionSearch { steps: Step[]; statements: StatementRef[]; sink?: Sink; failure?: WitnessFailureReason }

/**
 * Follows the calls of the Finding's statements into the functions they run and
 * collects the calls of an actual operation API it meets, nearest first, one per
 * sink statement, at most `maxWitnessPaths`. Without any, one entry says why.
 */
function findActions(index: PackageProgramIndex, file: FileRef, range: LineRange, behavior: BehaviorGroup): ActionSearch[] {
  const facts = index.internal.facts.get(fileKey(file));
  const starts = facts ? statementPathsAt(facts, range) : [];
  if (!facts || starts.length === 0) return [{ steps: [], statements: [], failure: 'NO_COMPLETE_PATH' }];
  const { limits } = index;
  const found: ActionSearch[] = [];
  const sinks = new Set<string>();
  const add = (sink: Sink, steps: Step[], statements: StatementRef[]) => {
    const key = `${statementKey(sink.statement)}\u0000${sink.name ?? ''}\u0000${sink.call?.node.start ?? ''}`;
    if (found.length >= limits.maxWitnessPaths || sinks.has(key)) return;
    sinks.add(key);
    found.push({ steps, statements, sink });
  };
  for (const start of starts) for (const sink of sinksAt(index, facts, start, behavior, true, false)) {
    const extendsFinding = sink.statement.startLine < range.startLine || sink.statement.endLine > range.endLine;
    add(sink, [], extendsFinding ? [sink.statement] : []);
  }
  for (const start of starts) {
    for (const sink of sinksUsing(index, facts, start, behavior)) {
      add(sink, [{ kind: 'REFERENCE', evidence: 'CONFIRMED', basis: 'DECLARED_NAME_USED', statement: sink.statement }], [sink.statement]);
    }
  }
  const deadline = Date.now() + limits.witnessSearchTimeoutMs;
  let edgeOf = callEdgeCache.get(index);
  if (!edgeOf) {
    edgeOf = new Map<t.Node, IndexedCallEdge>();
    for (const edge of index.calls) if (edge.invocation && edge.calleeId !== undefined && edge.kind !== 'CALLBACK') edgeOf.set(edge.invocation.path.node, edge);
    callEdgeCache.set(index, edgeOf);
  }
  let failure: WitnessFailureReason = 'NO_COMPLETE_PATH';
  interface Node { region: NodePath; facts: FileFacts; edges: IndexedCallEdge[]; probable: number }
  const queue: Node[] = starts.map((region) => ({ region, facts, edges: [], probable: 0 }));
  const entered = new Set<string>();
  let expanded = 0;
  while (queue.length > 0 && found.length < limits.maxWitnessPaths) {
    if (Date.now() > deadline || expanded >= limits.maxVisitedSymbols) break;
    const node = queue.shift()!;
    expanded += 1;
    const calls: Array<NodePath<t.CallExpression | t.NewExpression>> = [];
    const first = node.edges.length === 0;
    node.region.traverse({
      Function(path) { if (!first) path.skip(); },
      CallExpression(path) { calls.push(path); },
      NewExpression(path) { calls.push(path); },
    });
    if (node.region.isCallExpression()) calls.unshift(node.region);
    for (const call of calls) {
      const edge = edgeOf.get(call.node);
      if (!edge) {
        const reason = index.internal.values.expression(call.get('callee') as NodePath, node.facts).value;
        if (reason.kind === 'EXTERNAL') failure = 'EXTERNAL_BOUNDARY';
        else if (reason.kind === 'UNRESOLVED' && ['PARAMETER', 'COMPUTED_PROPERTY', 'THIS', 'INHERITED_METHOD'].includes(reason.reason) && failure === 'NO_COMPLETE_PATH') failure = 'DYNAMIC_DISPATCH';
        continue;
      }
      if (edge.evidence === 'UNRESOLVED' || entered.has(edge.calleeId!)) continue;
      const probable = node.probable + (edge.evidence === 'PROBABLE' ? 1 : 0);
      const edges = [...node.edges, edge];
      if (edges.length > (probable > 0 ? limits.maxProbableDepth : limits.maxCallDepth)) { failure = 'DEPTH_LIMIT'; continue; }
      const callee = index.symbols.get(edge.calleeId!);
      const calleeFacts = callee ? index.internal.facts.get(fileKey(callee)) : undefined;
      const body = calleeFacts?.functionOfSymbol.get(edge.calleeId!);
      if (!callee || !calleeFacts || !body) continue;
      entered.add(edge.calleeId!);
      for (const sink of sinksAt(index, calleeFacts, body, behavior, false, true)) {
        const steps = edges.map((item) => ({ kind: item.kind as string, evidence: item.evidence as EvidenceLevel, ...(item.basis === undefined ? {} : { basis: item.basis }), statement: item.site }));
        const statements = edges.flatMap((item) => {
          const symbol = index.symbols.get(item.calleeId!);
          return [item.site, ...item.links, ...(symbol?.header ? [{ artifactId: symbol.artifactId, filePath: symbol.filePath, ...symbol.header }] : [])];
        }).map((item) => compactStatement(index, item));
        add({ ...sink, entry: { functionId: edge.calleeId!, call: edge } }, steps, [...statements, sink.statement]);
      }
      queue.push({ region: body, facts: calleeFacts, edges, probable });
    }
  }
  return found.length > 0 ? found : [{ steps: [], statements: [], failure }];
}

const COMPARISONS = new Set(['===', '!==', '==', '!=', '<', '<=', '>', '>=', 'in', 'instanceof']);

/**
 * How an expression's value is consumed where it stands. `USED`: a call takes it as an argument, or it is only
 * compared or tested. `BOUND`: it initializes a name that is never assigned again, alone or inside an object or
 * array literal, or is what a `for...of` over it hands to such a name. `FIELD`: it is assigned to a field of the
 * instance. `LEAVES`: it is returned, stored in another property or passed on in a way that is not followed.
 */
type Consumption = { kind: 'USED' } | { kind: 'BOUND'; declarator: NodePath<t.VariableDeclarator> }
  | { kind: 'FIELD'; assignment: NodePath<t.AssignmentExpression>; name: string } | { kind: 'LEAVES' };
function consumption(expression: NodePath): Consumption {
  let node = expression;
  // Inside an object or array literal the value goes where the literal goes: into a call, or into a name that then holds the literal.
  let inLiteral = false;
  for (let parent = node.parentPath; parent; node = parent, parent = parent.parentPath) {
    if (parent.isObjectProperty() || parent.isObjectExpression() || parent.isArrayExpression()) { inLiteral = true; continue; }
    if ((parent.isCallExpression() || parent.isNewExpression()) && (parent.node.arguments as t.Node[]).includes(node.node)) return { kind: 'USED' };
    if (parent.isBinaryExpression() && COMPARISONS.has(parent.node.operator)) return { kind: 'USED' };
    if (parent.isUnaryExpression() && (parent.node.operator === '!' || parent.node.operator === 'typeof')) return { kind: 'USED' };
    if ((parent.isIfStatement() || parent.isConditionalExpression() || parent.isWhileStatement() || parent.isDoWhileStatement()) && parent.node.test === node.node) return { kind: 'USED' };
    if (parent.isSwitchStatement() && parent.node.discriminant === node.node) return { kind: 'USED' };
    if (parent.isVariableDeclarator()) {
      const binding = t.isIdentifier(parent.node.id) && parent.node.init === node.node ? parent.scope.getBinding(parent.node.id.name) : undefined;
      return binding?.constant ? { kind: 'BOUND', declarator: parent } : { kind: 'LEAVES' };
    }
    if (parent.isExpressionStatement()) return inLiteral ? { kind: 'LEAVES' } : { kind: 'USED' };
    if (parent.isForOfStatement() && parent.node.right === node.node && !inLiteral) {
      const left = parent.get('left');
      const declarator = left.isVariableDeclaration() && left.node.kind === 'const' ? left.get('declarations')[0] : undefined;
      return declarator && t.isIdentifier(declarator.node.id) ? { kind: 'BOUND', declarator } : { kind: 'LEAVES' };
    }
    if (parent.isAssignmentExpression()) {
      const { left, operator, right } = parent.node;
      if (operator === '=' && right === node.node && t.isMemberExpression(left) && t.isThisExpression(left.object) && !left.computed && t.isIdentifier(left.property)) {
        return { kind: 'FIELD', assignment: parent, name: left.property.name };
      }
      // Writing an environment variable: the assigned name is not a value read, and a value stored back into the environment stays there.
      const written = memberPath(parent.node.left as t.Node);
      return parent.node.left === node.node || (written?.[0] === 'process' && written[1] === 'env') ? { kind: 'USED' } : { kind: 'LEAVES' };
    }
    if (parent.isStatement() || parent.isFunction()
      || parent.isSpreadElement() || parent.isYieldExpression() || parent.isAwaitExpression()) return { kind: 'LEAVES' };
  }
  return { kind: 'LEAVES' };
}

/**
 * LINK of a read that is not a call: from the read to every statement that uses its value. Complete when the value
 * is consumed where it is read, or is held by a constant name or an instance field whose every use consumes it or
 * hands it on to another such holder, at most `MAX_READ_HOPS` holders deep. A field is a probable step: the read of
 * it may run before the write.
 */
function readUsePath(index: PackageProgramIndex, target: WitnessTarget, sink: Sink & { read: NodePath }): ContextWitnessPath {
  const incomplete = () => pathOf('LINK', target, [], [], 'NO_COMPLETE_PATH', sink);
  const first = consumption(sink.read);
  if (first.kind === 'LEAVES') return incomplete();
  if (first.kind === 'USED') return pathOf('LINK', target, [], [sink.statement], undefined, sink);
  type Holder = Exclude<Consumption, { kind: 'USED' } | { kind: 'LEAVES' }>;
  const held = (holder: Holder, statement: StatementRef): Step => (holder.kind === 'BOUND'
    ? { kind: 'INITIALIZER', evidence: 'CONFIRMED', basis: 'VARIABLE_INITIALIZER', statement }
    : { kind: 'PROPERTY_WRITE', evidence: 'PROBABLE', basis: 'FIELD_WRITE', statement });
  const referencesOf = (holder: Holder): NodePath[] | undefined => {
    if (holder.kind === 'BOUND') return holder.declarator.scope.getBinding((holder.declarator.node.id as t.Identifier).name)?.referencePaths ?? [];
    const owner = index.internal.values.classOfThis(holder.assignment.get('left').get('object') as NodePath);
    return owner ? index.internal.values.fieldReads(owner, holder.name) : undefined;
  };
  const steps: Step[] = [held(first, sink.statement)];
  const uses: StatementRef[] = [];
  const seen = new Set<t.Node>();
  const pending: Array<{ holder: Holder; hops: number }> = [{ holder: first, hops: 1 }];
  while (pending.length > 0) {
    const { holder, hops } = pending.shift()!;
    const references = referencesOf(holder);
    if (!references) return incomplete();
    for (const reference of references) {
      const use = consumption(reference);
      const statement = sinkStatement(index, sink.facts, reference);
      if (use.kind === 'LEAVES' || !statement) return incomplete();
      if (use.kind !== 'USED') {
        const node = use.kind === 'BOUND' ? use.declarator.node : use.assignment.node;
        if (hops >= MAX_READ_HOPS) return incomplete();
        if (seen.has(node)) continue;
        seen.add(node);
        pending.push({ holder: use, hops: hops + 1 });
      }
      if (uses.some((item) => statementKey(item) === statementKey(statement))) continue;
      uses.push(statement);
      steps.push(use.kind === 'USED' ? { kind: 'USE', evidence: 'CONFIRMED', basis: 'VALUE_USE', statement } : held(use, statement));
      if (uses.length > MAX_READ_USES) return incomplete();
    }
  }
  return pathOf('LINK', target, steps, [sink.statement, ...uses], undefined, sink);
}

/**
 * A source Finding can sit inside a value that is used by a later operation. Follow only the binding that contains
 * the exact call on the Finding line, and only to direct terminal call arguments. This avoids tracing every sibling
 * property of a large object as though it belonged to the Finding.
 */
function findingOutputLinks(index: PackageProgramIndex, file: FileRef, range: LineRange, target: WitnessTarget): ContextWitnessPath[] {
  const facts = index.internal.facts.get(fileKey(file));
  if (!facts) return [];
  let callsByLine = callsByLineCache.get(facts);
  if (!callsByLine) {
    callsByLine = new Map<number, Array<NodePath<t.CallExpression | t.NewExpression>>>();
    const add = (line: number | undefined, call: NodePath<t.CallExpression | t.NewExpression>) => {
      if (line === undefined) return;
      const calls = callsByLine!.get(line) ?? [];
      calls.push(call);
      callsByLine!.set(line, calls);
    };
    facts.program.traverse({
      CallExpression(path) { if (!loadCall(path)) add(path.node.loc?.start.line, path); },
      NewExpression(path) { add(path.node.loc?.start.line, path); },
    });
    callsByLineCache.set(facts, callsByLine);
  }
  const calls: Array<NodePath<t.CallExpression | t.NewExpression>> = [];
  for (let line = range.startLine; line <= range.endLine; line += 1) calls.push(...(callsByLine.get(line) ?? []));
  const paths: ContextWitnessPath[] = [];
  const seen = new Set<string>();
  for (const source of calls) {
    const declaration = source.findParent((path) => path.isVariableDeclarator()) as NodePath<t.VariableDeclarator> | null;
    if (!declaration || !t.isIdentifier(declaration.node.id) || !declaration.get('init').isAncestor(source)) continue;
    const binding = declaration.scope.getBinding(declaration.node.id.name);
    const sourcePath = statementOf(declaration);
    const sourceRange = rangeOf(sourcePath?.node);
    if (!binding?.constant || !sourceRange) continue;
    const sourceStatement: StatementRef = { ...facts.ref, ...sourceRange, symbol: declaration.node.id.name };
    for (const reference of binding.referencePaths) {
      const consumer = reference.parentPath;
      if (!consumer?.isCallExpression() || !(consumer.node.arguments as t.Node[]).includes(reference.node)) continue;
      const terminal = statementOf(consumer);
      const terminalRange = rangeOf(terminal?.node);
      if (!terminal?.isExpressionStatement() || !terminalRange || (reference.node.start ?? 0) <= (declaration.node.end ?? 0)) continue;
      const name = memberPath(consumer.node.callee)?.join('.');
      const key = `${terminalRange.startLine}\u0000${terminalRange.endLine}\u0000${name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sink: Sink = { facts, statement: { ...facts.ref, ...terminalRange }, call: consumer, ...(name === undefined ? {} : { name }) };
      const steps: Step[] = [];
      if (source.findParent((path) => path.isObjectProperty() && path.isDescendant(declaration))) {
        steps.push({ kind: 'PROPERTY_VALUE', evidence: 'CONFIRMED', basis: 'OBJECT_PROPERTY', statement: sourceStatement });
      }
      const transform = source.findParent((path) => path !== source && path.isCallExpression() && path.isDescendant(declaration));
      if (transform) steps.push({ kind: 'CALL_RESULT', evidence: 'CONFIRMED', basis: 'STATIC_CONTAINER_CALL', statement: sourceStatement });
      steps.push(
        { kind: 'INITIALIZER', evidence: 'CONFIRMED', basis: 'VARIABLE_INITIALIZER', statement: sourceStatement },
        { kind: 'ARGUMENT', evidence: 'CONFIRMED', basis: 'DIRECT_CALL_ARGUMENT', statement: sink.statement },
      );
      paths.push(pathOf('LINK', target, steps, [sourceStatement, sink.statement], undefined, sink));
    }
  }
  return paths;
}

function compositeActionPaths(
  index: PackageProgramIndex, file: FileRef, range: LineRange, target: WitnessTarget, actions: readonly ActionSearch[],
): ContextWitnessPath[] {
  const requirements = COMPOSITE_ACTION_STAGES[target.behavior];
  if (!requirements) return [];
  const available = requirements.map((requirement) => ({
    ...requirement, actions: actions.filter((action) => action.sink?.family !== undefined && requirement.families.includes(action.sink.family)),
  }));
  const requiredStages = requirements.map(({ stage }) => stage);
  const pathFor = (
    chosen: readonly ActionSearch[], link: ContextWitnessPath | undefined, failure?: WitnessFailureReason,
    connectionKind?: 'VALUE_FLOW' | 'NESTED_CALL',
  ) => {
    const stepKeys = new Set<string>();
    const steps = [...chosen.flatMap((action) => action.steps), ...(link?.steps ?? [])].filter((step) => {
      const key = `${step.kind}\u0000${statementKey(step.statement)}\u0000${step.evidence}`;
      return stepKeys.has(key) ? false : (stepKeys.add(key), true);
    });
    const statements = [...chosen.flatMap((action) => action.statements), ...(link?.statements ?? [])];
    const path = pathOf('ACTION', target, steps, statements, failure, chosen.at(-1)?.sink);
    const confirmedStages = chosen.flatMap((action) => available
      .filter((entry) => action.sink?.family !== undefined && entry.families.includes(action.sink.family)).map((entry) => entry.stage));
    const missingStages = requiredStages.filter((stage) => !confirmedStages.includes(stage));
    const missingConnections = missingStages.length === 0 && link === undefined ? [`${requiredStages[0]}->${requiredStages[1]}`] : [];
    const stageWitnesses = chosen.flatMap((action) => {
      const stage = available.find((entry) => action.sink?.family !== undefined && entry.families.includes(action.sink.family))?.stage;
      const sink = action.sink;
      if (!stage || !sink?.family) return [];
      return [{
        stage, family: sink.family,
        sink: { ...sink.statement, ...(sink.name === undefined ? {} : { callee: sink.name }) },
        steps: action.steps.map((step) => ({ ...step, statement: { ...step.statement } })),
        statements: unique(action.statements).map(({ artifactId, filePath, startLine, endLine }) => ({ artifactId, filePath, startLine, endLine })),
      }];
    });
    path.composite = {
      behavior: target.behavior as 'COLLECT_AND_SEND' | 'DOWNLOAD_AND_EXECUTE' | 'REMOTE_SHELL', requiredStages,
      confirmedStages: [...new Set(confirmedStages)], missingStages, missingConnections,
      stageWitnesses,
      connectionWitnesses: link && connectionKind ? [{
        fromStage: requiredStages[0]!, toStage: requiredStages[1]!, kind: connectionKind,
        steps: link.steps.map((step) => ({ ...step, statement: { ...step.statement } })),
        statements: link.statements.map((statement) => ({ ...statement })),
      }] : [],
      complete: path.complete && missingStages.length === 0 && missingConnections.length === 0,
      status: path.complete && missingStages.length === 0 && missingConnections.length === 0 ? 'COMPLETE' : 'PARTIAL',
    };
    if (!path.composite.complete && path.failureReason === undefined) {
      path.complete = false;
      path.failureReason = 'COMPOSITE_INCOMPLETE';
    }
    return path;
  };
  const complete: ContextWitnessPath[] = [];
  const discoveredUpstream: ActionSearch[] = [];
  for (const downstream of available[1]!.actions) {
    const call = downstream.sink?.call;
    if (!downstream.sink || !call) continue;
    const expressions = call.get('arguments') as NodePath[];
    const origins: ValueOrigin[] = expressions.map((expression) => ({
      expression, facts: downstream.sink!.facts, at: downstream.sink!.statement,
      ...(downstream.sink!.entry === undefined ? {} : { entry: downstream.sink!.entry }),
    }));
    const witness = findInputWitness(index, file, range, origins);
    const link = flowPath('LINK', target, witness);
    // Value-flow statements may contain the first operation even when the Finding is on the second one.
    for (const statement of witness.statements) {
      const facts = index.internal.facts.get(fileKey(statement));
      if (!facts) continue;
      for (const region of statementPathsAt(facts, statement)) {
        for (const sink of sinksAt(index, facts, region, target.behavior, false, false)) {
          if (sink.family !== undefined && available[0]!.families.includes(sink.family)
            && !discoveredUpstream.some((item) => item.sink && statementKey(item.sink.statement) === statementKey(sink.statement) && item.sink.name === sink.name)) {
            discoveredUpstream.push({ steps: [], statements: [sink.statement], sink });
          }
        }
      }
    }
    const upstreamActions = [...available[0]!.actions, ...discoveredUpstream];
    for (const upstream of upstreamActions) {
      if (!upstream.sink) continue;
      const nested = upstream.sink.call !== undefined
        && (upstream.sink.call.isDescendant(call) || call.isDescendant(upstream.sink.call));
      const sourceReached = witness.edges.some((edge) => edge.from !== undefined && statementKey(edge.from) === statementKey(upstream.sink!.statement));
      if (!nested && (!link.complete || !sourceReached)) continue;
      const path = pathFor([upstream, downstream], link, undefined, nested ? 'NESTED_CALL' : 'VALUE_FLOW');
      if (path.complete && path.composite?.complete) complete.push(path);
      if (complete.length >= index.limits.maxWitnessPaths) break;
    }
    if (complete.length >= index.limits.maxWitnessPaths) break;
  }
  if (complete.length > 0) return complete;
  const partial = [available[0]!.actions[0] ?? discoveredUpstream[0], available[1]!.actions[0]].filter((action): action is ActionSearch => action !== undefined);
  return [pathFor(partial, undefined, 'COMPOSITE_INCOMPLETE')];
}

/**
 * ACTION: the Finding's statement to the call of the actual operation API.
 * TARGET: where the first argument of that call (the URL, command, path or code) is produced.
 * LINK: how values reach that call, traced from everything the statement holding it reads.
 * Each sink the search finds gives one path per context.
 */
export function buildActionPaths(
  index: PackageProgramIndex, file: FileRef, range: LineRange, target: WitnessTarget, contexts: readonly ContextCode[],
): ContextWitnessPath[] {
  const cacheKey = `${fileKey(file)}\u0000${range.startLine}\u0000${range.endLine}\u0000${target.behavior}\u0000${[...contexts].sort().join(',')}`;
  const cached = actionPathCache.get(index)?.get(cacheKey);
  if (cached) return cached.map((path) => ({ ...structuredClone(path), groupId: target.groupId, findingId: target.findingId, pathId: '' }));
  const paths: ContextWitnessPath[] = [];
  const actions = findActions(index, file, range, target.behavior);
  const forwardLinks = contexts.includes('LINK') ? findingOutputLinks(index, file, range, target) : [];
  if (contexts.includes('ACTION')) {
    const composite = compositeActionPaths(index, file, range, target, actions);
    if (composite.length > 0) paths.push(...composite);
    else for (const action of actions) paths.push(pathOf('ACTION', target, action.steps, action.statements, action.failure, action.sink));
  }
  for (const action of actions) {
    const call = action.sink?.call;
    for (const context of ['TARGET', 'LINK'] as const) {
      if (!contexts.includes(context)) continue;
      if (context === 'LINK' && forwardLinks.length > 0) continue;
      // A read such as `process.env` has no arguments to follow a value into; its LINK is where the value read goes.
      if (action.sink && !call && context === 'LINK' && action.sink.read && action.failure === undefined) {
        paths.push(readUsePath(index, target, { ...action.sink, read: action.sink.read }));
        continue;
      }
      if (!action.sink || (!call && context === 'LINK')) { paths.push(pathOf(context, target, [], [], action.failure ?? 'NO_COMPLETE_PATH', action.sink)); continue; }
      // TARGET is what the call is aimed at; LINK is every value the statement holding the call uses (`request(url).end(data)`).
      const holder = call ? statementOf(call) : null;
      const expressions = context === 'TARGET' ? (call ? (call.get('arguments') as NodePath[]).slice(0, 1) : []) : holder ? readsOf(holder) : [];
      const origins: ValueOrigin[] = expressions.map((expression) => ({
        expression, facts: action.sink!.facts, at: action.sink!.statement, ...(action.sink!.entry === undefined ? {} : { entry: action.sink!.entry }),
      }));
      const witness = findInputWitness(index, file, range, origins);
      // The way into the wrapper is part of how a value reaches the sink.
      paths.push(flowPath(context, target, witness, context === 'LINK' ? action.statements : [action.sink.statement], action.sink));
    }
  }
  paths.push(...forwardLinks);
  // Selection treats complete paths with the same statements as one path. Remove them before they inflate the
  // candidate queue, keeping the same best-first ordering that selection applies when the missing lines are equal.
  const ratio = (path: ContextWitnessPath) => (path.depth === 0 ? 1 : path.confirmedEdgeCount / path.depth);
  const better = (left: ContextWitnessPath, right: ContextWitnessPath) => (
    Math.min(left.probableEdgeCount, 1) - Math.min(right.probableEdgeCount, 1)
    || left.probableEdgeCount - right.probableEdgeCount
    || ratio(right) - ratio(left)
    || left.depth - right.depth
  ) < 0;
  const result: ContextWitnessPath[] = [];
  const positions = new Map<string, number>();
  for (const path of paths) {
    if (!path.complete || path.statements.length === 0) { result.push(path); continue; }
    const key = `${path.context}\u0000${path.sink?.callee ?? ''}\u0000${path.statements.map(statementKey).sort().join('|')}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push(path);
    } else if (better(path, result[position]!)) {
      result[position] = path;
    }
  }
  const byQuery = actionPathCache.get(index) ?? new Map<string, ContextWitnessPath[]>();
  byQuery.set(cacheKey, structuredClone(result));
  actionPathCache.set(index, byQuery);
  return result;
}
