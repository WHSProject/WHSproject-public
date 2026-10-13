import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { memberPath, rangeOf, statementOf } from '../code-units';
import type { IndexedCallEdge, Resolved, ValueResolver } from './call-graph';
import { EVIDENCE_RANK, type EvidenceLevel, type ProgramSymbol, type StatementRef } from './program-index.contract';
import type { FileFacts } from './program-parse';

export interface CallbackInput {
  call: NodePath<t.CallExpression | t.NewExpression>;
  argumentIndex: number;
  /** The function handed over; always a FUNCTION value. */
  callback: Resolved;
  /** What the call's callee resolved to, when it was looked up. */
  callee: Resolved | undefined;
  file: FileFacts;
  caller: ProgramSymbol;
  site: StatementRef;
  resolver: ValueResolver;
}

/** Array and string methods that call their callback before they return. */
const SYNCHRONOUS_METHODS = new Set([
  'forEach', 'map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort',
  'replace', 'replaceAll',
]);
const ARRAY_PRODUCERS = new Set(['Object.keys', 'Object.values', 'Object.entries', 'Object.getOwnPropertyNames', 'Array.from', 'Array.of']);
const ARRAY_RETURNING_METHODS = new Set(['split', 'readdirSync']);
const ARRAY_KEEPING_METHODS = new Set(['map', 'filter', 'slice', 'concat', 'flatMap', 'reverse', 'sort']);
const TIMER_FUNCTIONS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame']);
/** Scheduled to run once the current synchronous run ends; nothing outside the code decides whether they run. */
const MICROTASK_FUNCTIONS: Record<string, string> = { queueMicrotask: 'QUEUE_MICROTASK', 'process.nextTick': 'PROCESS_NEXT_TICK' };
const IO_CALLBACK_MODULES: Record<string, string> = { fs: 'FS_CALLBACK', 'fs/promises': 'FS_CALLBACK', child_process: 'CHILD_PROCESS_CALLBACK' };
const WATCHERS = new Set(['watch', 'watchFile', 'unwatchFile']);
const LISTENER_METHODS = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener']);
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);
/** Helpers the TypeScript compiler emits, with the argument that holds the function body they call before returning. */
const COMPILER_HELPERS: Record<string, number> = { __awaiter: 3, __generator: 1 };

/** The helper a call names, when it is the compiler's own: taken from `tslib`, or defined in the file as a function that calls that argument. */
function compilerHelper(input: CallbackInput): string | undefined {
  let callee = input.call.get('callee') as NodePath;
  if (callee.isSequenceExpression()) callee = callee.get('expressions').at(-1)!;
  const name = callee.isIdentifier() ? callee.node.name
    : callee.isMemberExpression() && !callee.node.computed && t.isIdentifier(callee.node.property) ? callee.node.property.name : undefined;
  if (name === undefined || COMPILER_HELPERS[name] !== input.argumentIndex) return undefined;
  if (input.callee?.value.kind === 'EXTERNAL') return input.callee.value.module === 'tslib' ? name : undefined;
  if (!callee.isIdentifier()) return undefined;
  const binding = callee.scope.getBinding(name);
  if (!binding?.constant) return undefined;
  const init = binding.path.isVariableDeclarator() ? binding.path.get('init') as NodePath : binding.path;
  const helper = init.isLogicalExpression({ operator: '||' }) ? init.get('right') as NodePath : init;
  if (!helper.isFunction()) return undefined;
  const parameter = helper.node.params[input.argumentIndex];
  const handed = t.isIdentifier(parameter) ? helper.scope.getBinding(parameter.name) : undefined;
  // `generator.apply(thisArg, args)`, `body.call(thisArg, state)` or a plain call.
  const called = handed?.referencePaths.some((reference) => {
    const user = reference.parentPath;
    if (user?.isCallExpression() && user.node.callee === reference.node) return true;
    return user?.isMemberExpression() === true && user.node.object === reference.node && t.isIdentifier(user.node.property)
      && ['apply', 'call'].includes(user.node.property.name) && user.parentPath?.isCallExpression() === true && user.parentPath.node.callee === user.node;
  });
  return called === true ? name : undefined;
}

/** Constant direct aliases of one locally constructed EventEmitter, in both directions. */
function emitterAliases(initial: Binding, resolver: ValueResolver, file: FileFacts): Binding[] {
  const aliases: Binding[] = [];
  const queue = [initial];
  const seen = new Set<Binding>();
  const add = (binding: Binding | undefined) => {
    if (!binding || seen.has(binding) || !binding.constant) return;
    const reference = binding.path.isVariableDeclarator() ? binding.path.get('id') as NodePath : binding.path;
    if (resolver.expression(reference, file).value.kind !== 'EMITTER') return;
    seen.add(binding);
    queue.push(binding);
  };
  while (queue.length > 0) {
    const binding = queue.shift()!;
    if (aliases.includes(binding)) continue;
    aliases.push(binding);
    if (binding.path.isVariableDeclarator()) {
      const init = binding.path.get('init') as NodePath;
      if (init.isIdentifier()) add(init.scope.getBinding(init.node.name));
    }
    for (const reference of binding.referencePaths) {
      const declarator = reference.parentPath;
      if (!declarator?.isVariableDeclarator() || declarator.node.init !== reference.node || !t.isIdentifier(declarator.node.id)) continue;
      add(declarator.scope.getBinding(declarator.node.id.name));
    }
  }
  return aliases;
}

const weaker = (left: EvidenceLevel, right: EvidenceLevel): EvidenceLevel => (EVIDENCE_RANK[left] >= EVIDENCE_RANK[right] ? left : right);

/** Whether the expression is an array as written: a literal, a built-in that returns one, or a constant bound to either. */
function isStaticArray(path: NodePath, depth = 0): boolean {
  if (depth > 4) return false;
  if (path.isArrayExpression()) return true;
  if (path.isIdentifier()) {
    const binding = path.scope.getBinding(path.node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return false;
    const init = binding.path.get('init') as NodePath;
    return init.node ? isStaticArray(init, depth + 1) : false;
  }
  if (!path.isCallExpression()) return false;
  const callee = path.get('callee') as NodePath;
  const name = memberPath(callee.node)?.join('.');
  if (name !== undefined && ARRAY_PRODUCERS.has(name) && !path.scope.getBinding(name.split('.')[0]!)) return true;
  if (!callee.isMemberExpression() || callee.node.computed || !t.isIdentifier(callee.node.property)) return false;
  const method = callee.node.property.name;
  if (ARRAY_RETURNING_METHODS.has(method)) return true;
  return ARRAY_KEEPING_METHODS.has(method) && isStaticArray(callee.get('object') as NodePath, depth + 1);
}

/**
 * `Promise.resolve(…).then(callback)` is taken as run only when the source
 * leaves no doubt: the global `Promise` is the built-in one, the shape is
 * exactly this, the callback is the first argument, nothing after the
 * registration in the same body ends the process or throws, and no file of the
 * package redefines `Promise` or `then`. Otherwise the reason it is not is returned.
 */
function promiseDoubt(input: CallbackInput, method: string): string | undefined {
  const callee = input.call.get('callee') as NodePath<t.MemberExpression>;
  const receiver = callee.get('object') as NodePath;
  if (method !== 'then') return 'NOT_A_THEN_CALLBACK';
  if (input.argumentIndex !== 0) return 'REJECTION_HANDLER';
  if (!receiver.isCallExpression() || memberPath(receiver.node.callee)?.join('.') !== 'Promise.resolve') return 'RECEIVER_NOT_PROMISE_RESOLVE';
  if (input.call.scope.getBinding('Promise')) return 'PROMISE_SHADOWED';
  if (input.resolver.input.promiseRedefined) return 'PROMISE_REDEFINED';
  if (input.caller.terminatorLines.some((line) => line > input.site.startLine)) return 'TERMINATION_AFTER_REGISTRATION';
  return undefined;
}

/** `callee(…, callback, …)` where the callee is a function of the package that calls that parameter itself. */
function parameterInvocation(input: CallbackInput): NodePath<t.CallExpression> | 'PASSED_ON' | undefined {
  if (input.callee?.value.kind !== 'FUNCTION') return undefined;
  const symbol = input.callee.value.symbol;
  const file = input.resolver.input.files.get(`${symbol.artifactId}\u0000${symbol.filePath}`);
  const fn = file?.functionOfSymbol.get(symbol.id);
  const parameter = fn?.node.params[input.argumentIndex];
  if (!fn || !t.isIdentifier(parameter)) return undefined;
  const binding = fn.scope.getBinding(parameter.name);
  if (!binding?.constant) return undefined;
  for (const reference of binding.referencePaths) {
    const user = reference.parentPath;
    if (user?.isCallExpression() && user.node.callee === reference.node && reference.getFunctionParent() === fn) return user;
  }
  return 'PASSED_ON';
}

/**
 * What handing `callback` to this call establishes. Only a callback that the
 * source shows being called (a synchronous built-in on an array, a package
 * function that calls its parameter, a local `emit` after the listener was
 * added, an unquestionable `Promise.resolve().then`) is confirmed. A timer, an
 * outside event and an unknown receiver only register it.
 */
export function classifyCallback(input: CallbackInput): IndexedCallEdge[] {
  return classify(input).map((edge) => {
    const run = edge.evidence !== 'UNRESOLVED' && (edge.callbackKind === 'SYNCHRONOUS_CALLBACK' || edge.callbackKind === 'LOCALLY_EMITTED_EVENT');
    const executedAt = !run ? undefined : edge.callbackKind === 'LOCALLY_EMITTED_EVENT' ? edge.site
      : edge.invocation ? invocationSite(edge, input) : edge.site;
    const basis = edge.basis ?? edge.unresolvedReason
      ?? (edge.callbackKind === 'LOCALLY_EMITTED_EVENT' ? 'LISTENER_ADDED_BEFORE_LOCAL_EMIT'
        : edge.callbackKind === 'PROMISE_MICROTASK' ? 'PROMISE_RESOLVE_THEN'
          : edge.invocation ? 'PARAMETER_CALLED_BY_CALLEE' : input.call.isNewExpression() ? 'PROMISE_EXECUTOR' : 'ARRAY_RECEIVER');
    return { ...edge, basis, registeredAt: input.site, ...(executedAt === undefined ? {} : { executedAt }) };
  });
}

function invocationSite(edge: IndexedCallEdge, input: CallbackInput): StatementRef {
  const range = edge.invocation ? rangeOf(statementOf(edge.invocation.path)?.node) : undefined;
  return range && edge.invocation ? input.resolver.statement(edge.invocation.file, range) : edge.site;
}

/** A string that is fixed in the source: a literal, or a constant bound to one. */
function staticString(path: NodePath | undefined): string | undefined {
  if (!path?.node) return undefined;
  if (path.isStringLiteral()) return path.node.value;
  if (path.isTemplateLiteral() && path.node.expressions.length === 0) return path.node.quasis[0]?.value.cooked ?? undefined;
  if (!path.isIdentifier()) return undefined;
  const binding = path.scope.getBinding(path.node.name);
  if (!binding?.constant || !binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) return undefined;
  const init = binding.path.get('init') as NodePath;
  return init.isStringLiteral() ? init.node.value : undefined;
}

function classify(input: CallbackInput): IndexedCallEdge[] {
  const { call, callback, file, caller, site, resolver } = input;
  if (callback.value.kind !== 'FUNCTION') return [];
  const target = callback.value.symbol;
  const base = { callerId: caller.id, calleeId: target.id, ...(target.name === undefined ? {} : { calleeName: target.name }),
    kind: 'CALLBACK' as const, site, links: callback.links, registration: { path: call, file } };
  // A callback that is handed over is taken as run once its timer, event or operation fires, unless the run is ended right after.
  const registered = (callbackKind: NonNullable<IndexedCallEdge['callbackKind']>, reason: string, evidence: EvidenceLevel = 'CONFIRMED_ASYNC'): IndexedCallEdge[] => {
    const stopped = evidence === 'CONFIRMED_ASYNC' && caller.terminatorLines.some((line) => line > site.startLine);
    if (evidence !== 'CONFIRMED_ASYNC' || stopped) {
      return [{ ...base, callbackKind, evidence: weaker(callback.evidence, 'PROBABLE'), asyncBoundary: true, unresolvedReason: stopped ? 'TERMINATION_AFTER_REGISTRATION' : reason }];
    }
    return [{ ...base, callbackKind, evidence: weaker(callback.evidence, 'CONFIRMED_ASYNC'), asyncBoundary: true, basis: `REGISTERED_CALLBACK:${reason}` }];
  };
  const calleePath = call.get('callee') as NodePath;
  const calleeName = memberPath(calleePath.node)?.join('.');

  // new Promise(executor): the executor runs inside the constructor.
  if (call.isNewExpression()) {
    if (calleePath.isIdentifier() && calleePath.node.name === 'Promise' && !call.scope.getBinding('Promise') && input.argumentIndex === 0) {
      return [{ ...base, callbackKind: 'SYNCHRONOUS_CALLBACK', evidence: weaker(callback.evidence, resolver.input.promiseRedefined ? 'PROBABLE' : 'CONFIRMED'), asyncBoundary: false,
        ...(resolver.input.promiseRedefined ? { unresolvedReason: 'PROMISE_REDEFINED' } : {}) }];
    }
    return registered('UNKNOWN_CALLBACK', 'CONSTRUCTOR_ARGUMENT');
  }

  if (compilerHelper(input) !== undefined) {
    return [{ ...base, callbackKind: 'SYNCHRONOUS_CALLBACK', evidence: callback.evidence, asyncBoundary: false, basis: 'COMPILER_ASYNC_HELPER' }];
  }

  const invoked = parameterInvocation(input);
  if (invoked === 'PASSED_ON') return registered('UNKNOWN_CALLBACK', 'CALLBACK_PASSED_ON');
  if (invoked) {
    const calleeFile = resolver.input.files.get(`${input.callee!.value.kind === 'FUNCTION' ? input.callee!.value.symbol.artifactId : ''}\u0000${input.callee!.value.kind === 'FUNCTION' ? input.callee!.value.symbol.filePath : ''}`);
    const range = rangeOf(statementOf(invoked)?.node);
    const link = calleeFile && range ? [resolver.statement(calleeFile, range)] : [];
    return [{
      ...base, links: [...input.callee!.links, ...link, ...callback.links], callbackKind: 'SYNCHRONOUS_CALLBACK',
      evidence: weaker(callback.evidence, input.callee!.evidence), asyncBoundary: false,
      ...(calleeFile ? { invocation: { path: invoked, file: calleeFile, argumentOffset: 0 } } : {}),
    }];
  }

  if (calleeName !== undefined && MICROTASK_FUNCTIONS[calleeName] !== undefined && !call.scope.getBinding(calleeName.split('.')[0]!) && input.argumentIndex === 0) {
    // Promoted only when nothing after the registration ends the run before the queue is drained.
    const stopped = caller.terminatorLines.some((line) => line > site.startLine);
    return [{
      ...base, callbackKind: 'PROMISE_MICROTASK', evidence: stopped ? 'PROBABLE' : weaker(callback.evidence, 'CONFIRMED_ASYNC'), asyncBoundary: true,
      basis: MICROTASK_FUNCTIONS[calleeName]!, ...(stopped ? { unresolvedReason: 'TERMINATION_AFTER_REGISTRATION' } : {}),
    }];
  }
  if (calleeName !== undefined && TIMER_FUNCTIONS.has(calleeName) && !call.scope.getBinding(calleeName.split('.')[0]!)) return registered('TIMER_CALLBACK', 'TIMER');
  if (calleeName !== undefined && ['global', 'globalThis', 'window']
    .some((root) => TIMER_FUNCTIONS.has(calleeName.replace(`${root}.`, '')) && calleeName.startsWith(`${root}.`))) return registered('TIMER_CALLBACK', 'TIMER');

  if (calleePath.isMemberExpression() && !calleePath.node.computed && t.isIdentifier(calleePath.node.property)) {
    const method = calleePath.node.property.name;
    const receiver = calleePath.get('object') as NodePath;

    if (PROMISE_METHODS.has(method)) {
      const doubt = promiseDoubt(input, method);
      return doubt === undefined
        ? [{ ...base, callbackKind: 'PROMISE_MICROTASK', evidence: weaker(callback.evidence, 'CONFIRMED_ASYNC'), asyncBoundary: true }]
        : registered('PROMISE_MICROTASK', doubt, 'PROBABLE');
    }

    if (LISTENER_METHODS.has(method) || method === 'addEventListener') {
      const event = staticString((call.get('arguments') as NodePath[])[0]);
      const emitter = receiver.isIdentifier() ? receiver.scope.getBinding(receiver.node.name) : undefined;
      if (!emitter || resolver.expression(receiver, file).value.kind !== 'EMITTER') return registered('EXTERNAL_EVENT_CALLBACK', 'EXTERNAL_EVENT');
      if (!emitter.constant) return registered('EXTERNAL_EVENT_CALLBACK', 'EMITTER_IDENTITY_UNCLEAR');
      if (event === undefined) return registered('EXTERNAL_EVENT_CALLBACK', 'DYNAMIC_EVENT_NAME');
      const emitted: IndexedCallEdge[] = [];
      for (const reference of emitterAliases(emitter, resolver, file).flatMap((binding) => binding.referencePaths)) {
        const access = reference.parentPath;
        const emit = access?.parentPath;
        if (!access?.isMemberExpression() || access.node.object !== reference.node || access.node.computed || !t.isIdentifier(access.node.property, { name: 'emit' })) continue;
        if (!emit?.isCallExpression() || emit.node.callee !== access.node) continue;
        if (staticString((emit.get('arguments') as NodePath[])[0]) !== event) continue;
        const emitSymbol = resolver.symbolAt(file, emit);
        const range = rangeOf(statementOf(emit)?.node);
        if (!range) continue;
        // The listener has to be in place when the event is emitted: same body, registration first.
        const ordered = emitSymbol.id === caller.id && (emit.node.start ?? 0) > (call.node.end ?? Number.MAX_SAFE_INTEGER);
        emitted.push({
          ...base, callerId: emitSymbol.id, site: resolver.statement(file, range), links: [site, ...callback.links], callbackKind: 'LOCALLY_EMITTED_EVENT',
          evidence: ordered ? callback.evidence : weaker(callback.evidence, 'PROBABLE'), asyncBoundary: false,
          ...(ordered ? {} : { unresolvedReason: 'EMIT_ORDER_NOT_ESTABLISHED' }),
          invocation: { path: emit, file, argumentOffset: 1 },
        });
      }
      return emitted.length > 0 ? emitted : registered('EXTERNAL_EVENT_CALLBACK', 'NO_LOCAL_EMIT');
    }

    if (SYNCHRONOUS_METHODS.has(method)) {
      const array = isStaticArray(receiver);
      return [{ ...base, callbackKind: 'SYNCHRONOUS_CALLBACK', evidence: array ? callback.evidence : weaker(callback.evidence, 'PROBABLE'),
        asyncBoundary: false, ...(array ? {} : { unresolvedReason: 'RECEIVER_NOT_STATIC_ARRAY' }) }];
    }
  }

  // A callback of an fs or child_process call is scheduled by that call and runs when the operation completes.
  const api = input.callee?.value.kind === 'EXTERNAL' ? input.callee.value : undefined;
  const io = api ? IO_CALLBACK_MODULES[api.module.replace(/^node:/u, '')] : undefined;
  if (api && io !== undefined && !WATCHERS.has(api.member ?? '')) {
    return [{ ...base, callbackKind: 'EXTERNAL_EVENT_CALLBACK', evidence: weaker(callback.evidence, 'PROBABLE'), asyncBoundary: true, basis: io, unresolvedReason: 'RUNS_WHEN_OPERATION_COMPLETES' }];
  }
  // A built-in or dependency API decides when the callback runs: a file, network or process event.
  const root = calleePath.isMemberExpression() ? rootOf(calleePath) : calleePath;
  const origin = input.callee?.value.kind === 'EXTERNAL' || (root?.isIdentifier() === true && (root.node.name === 'process' || resolver.expression(root, file).value.kind === 'EXTERNAL'));
  return origin ? registered('EXTERNAL_EVENT_CALLBACK', 'EXTERNAL_API') : registered('UNKNOWN_CALLBACK', 'UNKNOWN_CALLEE');
}

function rootOf(path: NodePath): NodePath | undefined {
  let current: NodePath = path;
  for (let depth = 0; depth < 16; depth += 1) {
    if (current.isMemberExpression()) current = current.get('object') as NodePath;
    else if (current.isCallExpression()) current = current.get('callee') as NodePath;
    else return current;
  }
  return undefined;
}
