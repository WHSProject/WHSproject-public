import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { isRunDirectlyTest, memberPath, rangeOf, statementOf } from '../code-units';
import { actionFactoryResult } from './action-apis';
import { classifyCallback } from './callback-kinds';
import {
  EVIDENCE_RANK, fileKey,
  type CallEdge, type EvidenceLevel, type LineRange, type ModuleEdge, type ProgramSymbol, type StatementRef,
} from './program-index.contract';
import { loadCall, type FileFacts } from './program-parse';

/** What an expression denotes, as far as the source shows it. */
export type Value =
  | { kind: 'FUNCTION'; symbol: ProgramSymbol }
  | { kind: 'MODULE'; file: FileFacts }
  | { kind: 'OBJECT'; path: NodePath<t.ObjectExpression>; file: FileFacts }
  | { kind: 'CLASS'; path: NodePath<t.Class>; file: FileFacts }
  | { kind: 'INSTANCE'; classPath: NodePath<t.Class>; file: FileFacts }
  /** An `EventEmitter` created in the code; `classPath` when it is an instance of a class of the package that extends it. */
  | { kind: 'EMITTER'; classPath?: NodePath<t.Class>; file?: FileFacts }
  /** A built-in or dependency module, or one of its members. */
  | { kind: 'EXTERNAL'; module: string; member?: string }
  | { kind: 'UNRESOLVED'; reason: string };

export interface Resolved { value: Value; evidence: EvidenceLevel; links: StatementRef[] }

/** A call edge together with the call whose arguments reach the callee's parameters. */
export interface IndexedCallEdge extends CallEdge {
  invocation?: { path: NodePath<t.CallExpression | t.NewExpression>; file: FileFacts; argumentOffset: number };
  /** CALLBACK only: the call the callback was handed to. */
  registration?: { path: NodePath<t.CallExpression | t.NewExpression>; file: FileFacts };
}

export interface GraphInput {
  files: ReadonlyMap<string, FileFacts>;
  /** Target of every import, keyed by the import's node. */
  loads: ReadonlyMap<t.Node, ModuleEdge>;
  /** Target of every re-export, by file and specifier. */
  reexports: ReadonlyMap<string, ModuleEdge>;
  /** Some file of the package assigns or defines `Promise` or `Promise.prototype.then`. */
  promiseRedefined: boolean;
}

export interface ValueResolver {
  expression(path: NodePath, file: FileFacts, depth?: number): Resolved;
  exported(file: FileFacts, name: string): Resolved;
  member(resolved: Resolved, name: string, depth?: number): Resolved;
  moduleOf(node: t.Node): FileFacts | undefined;
  externalOf(node: t.Node): string | undefined;
  symbolAt(file: FileFacts, path: NodePath): ProgramSymbol;
  /** The class whose instance a `this` stands for: the class of the instance method, constructor or field initializer around it. */
  classOfThis(path: NodePath): NodePath<t.Class> | undefined;
  /** What an instance field holds, when the class writes it in exactly one place, nothing extends the class and no write is dynamic. */
  fieldValue(classPath: NodePath<t.Class>, name: string): NodePath | undefined;
  /** Where the class reads such a field (`this.name`), or undefined when what the field holds is not known. */
  fieldReads(classPath: NodePath<t.Class>, name: string): NodePath[] | undefined;
  statement(file: FileFacts, range: LineRange, symbol?: string): StatementRef;
  readonly input: GraphInput;
}

const MAX_ALIAS_DEPTH = 8;
/** Functions a call is tied to by name alone when its receiver cannot be resolved. */
const MAX_NAME_MATCHES = 2;
const BUILT_IN_METHODS = new Set([Array.prototype, String.prototype, Object.prototype, Function.prototype, Promise.prototype,
  Map.prototype, Set.prototype, RegExp.prototype, Number.prototype, Date.prototype]
  .flatMap((prototype) => Object.getOwnPropertyNames(prototype)));
const EVENT_MODULES = new Set(['events', 'node:events']);
const unresolved = (reason: string): Resolved => ({ value: { kind: 'UNRESOLVED', reason }, evidence: 'UNRESOLVED', links: [] });
const weaker = (left: EvidenceLevel, right: EvidenceLevel): EvidenceLevel => (EVIDENCE_RANK[left] >= EVIDENCE_RANK[right] ? left : right);
const keyOf = (node: t.ObjectMember | t.ClassMethod | t.ClassProperty | t.ClassPrivateMethod | t.ClassAccessorProperty | t.ClassPrivateProperty): string | undefined => {
  if (t.isClassPrivateMethod(node) || t.isClassPrivateProperty(node)) return node.key.id.name;
  const { key } = node as { key: t.Node; computed?: boolean };
  if (t.isIdentifier(key) && (node as { computed?: boolean }).computed !== true) return key.name;
  return t.isStringLiteral(key) ? key.value : undefined;
};

export function createValueResolver(input: GraphInput): ValueResolver {
  const moduleOf = (node: t.Node): FileFacts | undefined => {
    const edge = input.loads.get(node);
    return edge?.resolution === 'RESOLVED' && edge.to ? input.files.get(fileKey(edge.to)) : undefined;
  };
  const externalOf = (node: t.Node): string | undefined => {
    const edge = input.loads.get(node);
    return edge?.resolution === 'EXTERNAL' && edge.specifier !== null ? edge.specifier : undefined;
  };
  const statement = (file: FileFacts, range: LineRange, symbol?: string): StatementRef => (
    { ...file.ref, startLine: range.startLine, endLine: range.endLine, ...(symbol === undefined ? {} : { symbol }) }
  );
  const statementAt = (file: FileFacts, path: NodePath, symbol?: string): StatementRef[] => {
    const range = rangeOf(statementOf(path)?.node);
    return range ? [statement(file, range, symbol)] : [];
  };
  const symbolAt = (file: FileFacts, path: NodePath): ProgramSymbol => {
    const fn = path.getFunctionParent();
    return (fn && file.symbolOfFunction.get(fn.node)) ?? file.module;
  };
  /** The member of a class `this` belongs to; an arrow function takes `this` from around it, any other function has its own. */
  const holderOfThis = (path: NodePath): NodePath | undefined => {
    const holder = path.findParent((item) => (item.isFunction() && !item.isArrowFunctionExpression()) || item.isClassProperty() || item.isClassPrivateProperty());
    if (!holder || !(holder.isClassMethod() || holder.isClassPrivateMethod() || holder.isClassProperty() || holder.isClassPrivateProperty())) return undefined;
    return (holder.node as { static?: boolean }).static === true ? undefined : holder;
  };
  const classOfThis = (path: NodePath): NodePath<t.Class> | undefined => {
    const owner = holderOfThis(path)?.parentPath?.parentPath;
    return owner?.isClass() ? owner as NodePath<t.Class> : undefined;
  };
  // Classes some class of the package extends, and member names read as a value instead of being called: a method
  // handed over on its own no longer runs with the instance as `this`.
  let knowledge: { extended: Set<t.Node>; detached: Set<string> } | undefined;
  const classKnowledge = () => {
    if (knowledge) return knowledge;
    const found = knowledge = { extended: new Set<t.Node>(), detached: new Set<string>() };
    for (const file of input.files.values()) {
      file.program.traverse({
        Class(path) {
          const superClass = path.get('superClass') as NodePath;
          if (!superClass.node) return;
          const base = expression(superClass, file, 1).value;
          if (base.kind === 'CLASS') found.extended.add(base.path.node);
        },
        MemberExpression(path) {
          const { property, computed } = path.node;
          if (computed || !t.isIdentifier(property)) return;
          const parent = path.parentPath;
          if ((parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isNewExpression()) && parent.node.callee === path.node) return;
          // `x.method.bind(...)` keeps a receiver, and `x.field.name` reads through a field.
          if ((parent.isMemberExpression() || parent.isOptionalMemberExpression()) && parent.node.object === path.node) return;
          found.detached.add(property.name);
        },
      });
    }
    return found;
  };
  const fields = new Map<t.Node, { dynamic: boolean; writes: Map<string, Array<NodePath | undefined>> }>();
  const fieldsOf = (classPath: NodePath<t.Class>) => {
    const known = fields.get(classPath.node);
    if (known) return known;
    const record = { dynamic: false, writes: new Map<string, Array<NodePath | undefined>>() };
    fields.set(classPath.node, record);
    const write = (name: string, value: NodePath | undefined) => record.writes.set(name, [...(record.writes.get(name) ?? []), value]);
    const ownField = (target: t.Node): string | null | undefined => {
      if (!t.isMemberExpression(target) || !t.isThisExpression(target.object)) return undefined;
      if (!target.computed && t.isIdentifier(target.property)) return target.property.name;
      return t.isStringLiteral(target.property) ? target.property.value : null;
    };
    for (const item of classPath.get('body').get('body')) {
      if (item.isClassProperty() && item.node.static !== true) {
        const name = keyOf(item.node);
        if (name !== undefined && item.node.value) write(name, item.get('value') as NodePath);
      }
    }
    classPath.traverse({
      AssignmentExpression(path) {
        const name = ownField(path.node.left);
        if (name === undefined || classOfThis(path.get('left').get('object') as NodePath)?.node !== classPath.node) return;
        if (name === null) record.dynamic = true;
        else write(name, path.node.operator === '=' ? path.get('right') as NodePath : undefined);
      },
      UpdateExpression(path) {
        const name = ownField(path.node.argument);
        if (typeof name === 'string') write(name, undefined);
      },
      CallExpression(path) {
        if (memberPath(path.node.callee)?.join('.') === 'Object.assign' && t.isThisExpression(path.node.arguments[0])) record.dynamic = true;
      },
    });
    return record;
  };
  const fieldValue = (classPath: NodePath<t.Class>, name: string): NodePath | undefined => {
    if (classKnowledge().extended.has(classPath.node) || classPath.node.superClass) return undefined;
    const record = fieldsOf(classPath);
    const writes = record.writes.get(name) ?? [];
    return !record.dynamic && writes.length === 1 ? writes[0] : undefined;
  };
  const fieldReads = (classPath: NodePath<t.Class>, name: string): NodePath[] | undefined => {
    if (!fieldValue(classPath, name)) return undefined;
    const reads: NodePath[] = [];
    classPath.traverse({
      MemberExpression(path) {
        const { object, property, computed } = path.node;
        if (computed || !t.isThisExpression(object) || !t.isIdentifier(property, { name })) return;
        if (classOfThis(path.get('object') as NodePath)?.node !== classPath.node) return;
        if (path.parentPath.isAssignmentExpression() && path.parentPath.node.left === path.node) return;
        reads.push(path);
      },
    });
    return reads;
  };
  const emitterClass = (classPath: NodePath<t.Class>, file: FileFacts, depth: number): boolean => {
    const superClass = classPath.get('superClass') as NodePath;
    if (!superClass.node) return false;
    const base = expression(superClass, file, depth + 1).value;
    return base.kind === 'EXTERNAL' && EVENT_MODULES.has(base.module) && (base.member === undefined || base.member === 'EventEmitter');
  };

  /** What a module evaluates to for `require()`: its `module.exports` value, else its namespace. */
  const moduleValue = (file: FileFacts): Resolved => {
    const definition = file.exports.default;
    if (definition?.value && !file.program.node.body.some((item) => t.isExportDefaultDeclaration(item))) {
      const value = expression(definition.value, file, 1);
      if (value.value.kind !== 'UNRESOLVED') return { ...value, links: [statement(file, definition.statement), ...value.links] };
    }
    return { value: { kind: 'MODULE', file }, evidence: 'CONFIRMED', links: [] };
  };
  const reexportTarget = (file: FileFacts, specifier: string): FileFacts | undefined => {
    const edge = input.reexports.get(`${fileKey(file.ref)}\u0000${specifier}`);
    return edge?.resolution === 'RESOLVED' && edge.to ? input.files.get(fileKey(edge.to)) : undefined;
  };

  // Exports being resolved right now: a name that leads back to itself (`exports.a = exports.b; exports.b = exports.a`) ends there.
  const resolving = new Set<string>();
  // What a name resolved to when it was looked up on its own. A lookup made inside another one may have been cut short
  // by the cycle guard, so only outermost results are kept.
  const resolvedExports = new Map<string, Resolved>();
  const exported = (file: FileFacts, name: string): Resolved => {
    const key = `${fileKey(file.ref)}\u0000${name}`;
    const known = resolvedExports.get(key);
    if (known) return known;
    if (resolving.has(key)) return unresolved('EXPORT_CYCLE');
    resolving.add(key);
    try {
      const found = exportedValue(file, name);
      if (resolving.size === 1) resolvedExports.set(key, found);
      return found;
    } finally {
      resolving.delete(key);
    }
  };
  const exportedValue = (file: FileFacts, name: string): Resolved => {
    const definition = name === 'default' ? file.exports.default : file.exports.named.get(name);
    if (definition) {
      const link = statement(file, definition.statement, name);
      const withLink = (found: Resolved): Resolved => ({ ...found, links: [link, ...found.links] });
      if (definition.reexport) {
        const targetFile = reexportTarget(file, definition.reexport.specifier);
        if (!targetFile) return unresolved('REEXPORT_TARGET_UNRESOLVED');
        return withLink(definition.reexport.name === '*' ? { value: { kind: 'MODULE', file: targetFile }, evidence: 'CONFIRMED', links: [] } : exported(targetFile, definition.reexport.name));
      }
      if (definition.value) return withLink(expression(definition.value, file, 1));
      if (definition.localName !== undefined) {
        const binding = file.program.scope.getBinding(definition.localName);
        return binding ? withLink(fromBinding(binding, definition.localName, file, 1)) : unresolved('EXPORT_LOCAL_NOT_FOUND');
      }
    }
    if (name !== 'default') {
      // `module.exports = { name }` or `module.exports = object`.
      if (file.exports.default?.value) {
        const whole = moduleValue(file);
        if (whole.value.kind !== 'MODULE' || whole.value.file !== file) {
          const found = member(whole, name, 1);
          if (found.value.kind !== 'UNRESOLVED') return found;
        }
      }
      for (const star of file.exports.stars) {
        const targetFile = reexportTarget(file, star.specifier);
        if (!targetFile) continue;
        const found = exported(targetFile, name);
        if (found.value.kind !== 'UNRESOLVED') return { ...found, links: [statement(file, star.statement), ...found.links] };
      }
      return unresolved('EXPORT_NOT_FOUND');
    }
    // A default import of a module that only sets `exports.name` receives the whole exports object.
    return file.exports.named.size > 0 && !file.program.node.body.some((item) => t.isExportNamedDeclaration(item) || t.isExportAllDeclaration(item))
      ? { value: { kind: 'MODULE', file }, evidence: 'CONFIRMED', links: [] } : unresolved('EXPORT_NOT_FOUND');
  };

  const member = (resolved: Resolved, name: string, depth = 0): Resolved => {
    const { value } = resolved;
    const carry = (found: Resolved): Resolved => ({ value: found.value, evidence: weaker(resolved.evidence, found.evidence), links: [...resolved.links, ...found.links] });
    if (value.kind === 'MODULE') return carry(exported(value.file, name));
    if (value.kind === 'EXTERNAL') {
      return carry({ value: { kind: 'EXTERNAL', module: value.module, member: value.member === undefined ? name : `${value.member}.${name}` }, evidence: 'CONFIRMED', links: [] });
    }
    if (value.kind === 'OBJECT') {
      for (const property of value.path.get('properties')) {
        if (property.isSpreadElement()) continue;
        if (keyOf(property.node as t.ObjectMember) !== name) continue;
        if (property.isObjectMethod()) {
          const symbol = value.file.symbolOfFunction.get(property.node);
          return symbol ? carry({ value: { kind: 'FUNCTION', symbol }, evidence: 'CONFIRMED', links: [] }) : unresolved('METHOD_NOT_INDEXED');
        }
        if (property.isObjectProperty()) return carry(expression(property.get('value') as NodePath, value.file, depth + 1));
      }
      return unresolved('PROPERTY_NOT_FOUND');
    }
    if (value.kind === 'CLASS' || value.kind === 'INSTANCE') {
      const classPath = value.kind === 'CLASS' ? value.path : value.classPath;
      const wantStatic = value.kind === 'CLASS';
      for (const item of classPath.get('body').get('body')) {
        const { node } = item;
        if (!(t.isClassMethod(node) || t.isClassPrivateMethod(node) || t.isClassProperty(node))) continue;
        if (keyOf(node) !== name || (node.static === true) !== wantStatic) continue;
        if (t.isClassProperty(node)) return node.value ? carry(expression(item.get('value') as NodePath, value.file, depth + 1)) : unresolved('PROPERTY_NOT_FOUND');
        if (node.kind === 'get' || node.kind === 'set') return unresolved('ACCESSOR');
        const symbol = value.file.symbolOfFunction.get(node);
        return symbol ? carry({ value: { kind: 'FUNCTION', symbol }, evidence: 'CONFIRMED', links: [] }) : unresolved('METHOD_NOT_INDEXED');
      }
      // A field the class fills in one place holds what was put there.
      const held = wantStatic || depth > MAX_ALIAS_DEPTH ? undefined : fieldValue(classPath, name);
      if (held) {
        const found = expression(held, value.file, depth + 1);
        if (found.value.kind !== 'UNRESOLVED') return carry({ ...found, links: [...statementAt(value.file, held, name), ...found.links] });
      }
      if (!classPath.node.superClass) return unresolved('METHOD_NOT_FOUND');
      // A method the class does not define is its parent's when the parent is a class of the package.
      const parent = depth > MAX_ALIAS_DEPTH ? undefined : expression(classPath.get('superClass') as NodePath, value.file, depth + 1);
      if (parent?.value.kind !== 'CLASS') return unresolved('INHERITED_METHOD');
      const inherited: Resolved = { ...parent, value: wantStatic ? parent.value : { kind: 'INSTANCE', classPath: parent.value.path, file: parent.value.file } };
      return carry(member(inherited, name, depth + 1));
    }
    if (value.kind === 'EMITTER' && value.classPath && value.file) {
      // What the class itself defines; `on`, `emit` and the rest of the emitter stay with the emitter.
      const own = member({ ...resolved, value: { kind: 'INSTANCE', classPath: value.classPath, file: value.file } }, name, depth + 1);
      if (own.value.kind === 'FUNCTION') return own;
    }
    return unresolved(value.kind === 'UNRESOLVED' ? value.reason : 'MEMBER_OF_UNSUPPORTED_VALUE');
  };

  const fromBinding = (binding: Binding, name: string, file: FileFacts, depth: number): Resolved => {
    if (depth > MAX_ALIAS_DEPTH) return unresolved('ALIAS_DEPTH');
    const bindingPath = binding.path;
    const { node } = bindingPath;
    // A reassigned name may hold something else by the time it is used.
    const settle = (found: Resolved): Resolved => (binding.constant || found.value.kind === 'UNRESOLVED' ? found : { ...found, evidence: weaker(found.evidence, 'PROBABLE') });
    if (binding.kind === 'param') return unresolved('PARAMETER');
    if (t.isFunctionDeclaration(node)) {
      const symbol = file.symbolOfFunction.get(node);
      return symbol ? settle({ value: { kind: 'FUNCTION', symbol }, evidence: 'CONFIRMED', links: [] }) : unresolved('FUNCTION_NOT_INDEXED');
    }
    if (bindingPath.isClassDeclaration()) return settle({ value: { kind: 'CLASS', path: bindingPath as NodePath<t.Class>, file }, evidence: 'CONFIRMED', links: [] });
    if (bindingPath.isVariableDeclarator()) {
      const init = bindingPath.get('init') as NodePath;
      if (!init.node) return unresolved('NO_INITIALIZER');
      const literal = init.isFunction() || init.isObjectExpression() || init.isClassExpression();
      const links = literal ? [] : statementAt(file, bindingPath, name);
      const whole = expression(init, file, depth + 1);
      const { id } = bindingPath.node;
      if (t.isIdentifier(id)) return settle({ ...whole, links: [...links, ...whole.links] });
      if (t.isObjectPattern(id)) {
        const property = id.properties.find((item) => t.isObjectProperty(item) && t.isIdentifier(item.value) && item.value.name === name);
        const key = property && t.isObjectProperty(property) ? keyOf(property) : undefined;
        if (key === undefined) return unresolved('DESTRUCTURING_NOT_STATIC');
        const found = member({ ...whole, links: [...links, ...whole.links] }, key, depth + 1);
        return settle(found);
      }
      return unresolved('DESTRUCTURING_NOT_STATIC');
    }
    if (t.isImportDefaultSpecifier(node) || t.isImportSpecifier(node) || t.isImportNamespaceSpecifier(node)) {
      const declaration = bindingPath.parentPath;
      if (!declaration?.isImportDeclaration()) return unresolved('IMPORT_NOT_FOUND');
      const links = statementAt(file, declaration, name);
      const imported = t.isImportDefaultSpecifier(node) ? 'default' : t.isImportSpecifier(node) ? (t.isIdentifier(node.imported) ? node.imported.name : node.imported.value) : null;
      const external = externalOf(declaration.node);
      if (external !== undefined) return { value: { kind: 'EXTERNAL', module: external,
        ...(imported === null || imported === 'default' ? {} : { member: imported }) }, evidence: 'CONFIRMED', links: [] };
      const target = moduleOf(declaration.node);
      if (!target) return unresolved('IMPORT_TARGET_UNRESOLVED');
      if (imported === null) return { value: { kind: 'MODULE', file: target }, evidence: 'CONFIRMED', links };
      // A default import of a CommonJS module is its `module.exports`, which is what its default export resolves to.
      const found = exported(target, imported);
      return { ...found, links: [...links, ...found.links] };
    }
    return unresolved('UNSUPPORTED_BINDING');
  };

  const expression = (path: NodePath, file: FileFacts, depth = 0): Resolved => {
    if (depth > MAX_ALIAS_DEPTH) return unresolved('ALIAS_DEPTH');
    const { node } = path;
    if (path.isFunction()) {
      const symbol = file.symbolOfFunction.get(node);
      return symbol ? { value: { kind: 'FUNCTION', symbol }, evidence: 'CONFIRMED', links: [] } : unresolved('FUNCTION_NOT_INDEXED');
    }
    if (path.isObjectExpression()) return { value: { kind: 'OBJECT', path, file }, evidence: 'CONFIRMED', links: [] };
    if (path.isClass()) return { value: { kind: 'CLASS', path: path as NodePath<t.Class>, file }, evidence: 'CONFIRMED', links: [] };
    if (path.isAwaitExpression()) return expression(path.get('argument') as NodePath, file, depth + 1);
    if (t.isTSAsExpression(node) || t.isTSNonNullExpression(node) || t.isTSSatisfiesExpression(node) || t.isParenthesizedExpression(node) || t.isTSTypeAssertion(node)) {
      return expression(path.get('expression') as NodePath, file, depth + 1);
    }
    // `(0, module.name)(…)`: the compiled form of calling an imported function.
    if (path.isSequenceExpression()) {
      const items = path.get('expressions');
      return items.slice(0, -1).every((item) => item.isLiteral()) ? expression(items.at(-1)!, file, depth + 1) : unresolved('UNSUPPORTED_EXPRESSION');
    }
    if (path.isNewExpression()) {
      const callee = expression(path.get('callee') as NodePath, file, depth + 1);
      if (callee.value.kind === 'EXTERNAL' && EVENT_MODULES.has(callee.value.module) && (callee.value.member === undefined || callee.value.member === 'EventEmitter')) {
        return { value: { kind: 'EMITTER' }, evidence: callee.evidence, links: callee.links };
      }
      if (callee.value.kind === 'CLASS') {
        return emitterClass(callee.value.path, callee.value.file, depth)
          ? { value: { kind: 'EMITTER', classPath: callee.value.path, file: callee.value.file }, evidence: callee.evidence, links: callee.links }
          : { value: { kind: 'INSTANCE', classPath: callee.value.path, file: callee.value.file }, evidence: callee.evidence, links: callee.links };
      }
      // An instance of a dependency's class: `()` after the constructor's own path.
      if (callee.value.kind === 'EXTERNAL') {
        return { value: { kind: 'EXTERNAL', module: callee.value.module,
          member: `${callee.value.member === undefined ? '' : `${callee.value.member}.`}()` }, evidence: callee.evidence, links: callee.links };
      }
      return unresolved('CONSTRUCTED_VALUE');
    }
    if (path.isCallExpression()) {
      const load = loadCall(path);
      if (!load) {
        const callee = expression(path.get('callee') as NodePath, file, depth + 1);
        if (callee.value.kind === 'EXTERNAL') {
          const member = actionFactoryResult(callee.value.module, callee.value.member);
          if (member !== undefined) return { value: { kind: 'EXTERNAL', module: callee.value.module, member }, evidence: callee.evidence, links: callee.links };
        }
        return unresolved('CALL_RESULT');
      }
      const external = externalOf(node);
      if (external !== undefined) return { value: { kind: 'EXTERNAL', module: external }, evidence: 'CONFIRMED', links: [] };
      const target = moduleOf(node);
      if (!target) return unresolved('IMPORT_TARGET_UNRESOLVED');
      return load.kind === 'REQUIRE' ? moduleValue(target) : unresolved('DYNAMIC_IMPORT_RESULT');
    }
    if (path.isThisExpression()) {
      const holder = holderOfThis(path);
      const owner = classOfThis(path);
      if (!holder || !owner) {
        // A static method is kept as before: likely the class's own members, not established.
        const method = path.findParent((item) => item.isClassMethod() || item.isClassPrivateMethod() || item.isFunction());
        const staticOwner = method && (method.isClassMethod() || method.isClassPrivateMethod()) ? method.parentPath?.parentPath : undefined;
        return staticOwner?.isClass() ? { value: { kind: 'INSTANCE', classPath: staticOwner as NodePath<t.Class>, file }, evidence: 'PROBABLE', links: [] } : unresolved('THIS');
      }
      // `this` is the instance unless a subclass may stand in for it or the method around it is handed over without its receiver.
      const { extended, detached } = classKnowledge();
      const name = holder.isClassMethod() || holder.isClassPrivateMethod() ? keyOf(holder.node) : undefined;
      const settled = !extended.has(owner.node) && (name === undefined || name === 'constructor' || !detached.has(name));
      return { value: { kind: 'INSTANCE', classPath: owner, file }, evidence: settled ? 'CONFIRMED' : 'PROBABLE', links: [] };
    }
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(path.node.name);
      if (!binding) return path.node.name === 'exports' ? moduleValue(file) : unresolved('GLOBAL');
      return fromBinding(binding, path.node.name, file, depth);
    }
    if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
      const { property, computed } = path.node;
      const name = !computed && t.isIdentifier(property) ? property.name : t.isStringLiteral(property) ? property.value : undefined;
      if (name === undefined) return unresolved('COMPUTED_PROPERTY');
      const whole = memberPath(node)?.join('.');
      if (whole === 'module.exports' && !path.scope.getBinding('module')) return moduleValue(file);
      const object = path.get('object') as NodePath;
      if (object.isIdentifier() && object.node.name === 'exports' && !path.scope.getBinding('exports')) return exported(file, name);
      if (memberPath(object.node)?.join('.') === 'module.exports' && !path.scope.getBinding('module')) return exported(file, name);
      return member(expression(object, file, depth + 1), name, depth + 1);
    }
    return unresolved('UNSUPPORTED_EXPRESSION');
  };

  return { expression, exported, member, moduleOf, externalOf, symbolAt, classOfThis, fieldValue, fieldReads, statement, input };
}

/** The complete statement holding `path`, and the statement around it in the same body that decides whether it runs. */
export function siteOf(path: NodePath): { statement?: LineRange; within?: CallEdge['within'] } {
  const own = statementOf(path);
  const range = rangeOf(own?.node);
  if (!own || !range) return {};
  let outer: NodePath = own;
  for (let parent = own.parentPath; parent && !parent.isProgram() && !parent.isFunction(); parent = parent.parentPath) {
    if (parent.isStatement() && !parent.isBlockStatement()) outer = parent;
  }
  const outerRange = rangeOf(outer.node);
  if (outer === own || !outerRange) return { statement: range };
  const runDirectly = outer.isIfStatement() && isRunDirectlyTest(outer.node.test) && own.findParent((item) => item.parentPath === outer)?.key === 'consequent';
  const kind = runDirectly ? 'RUN_DIRECTLY' as const : outer.isIfStatement() || outer.isSwitchStatement() ? 'CONDITION' as const
    : outer.isLoop() ? 'LOOP' as const : outer.isTryStatement() ? 'TRY' as const : 'OTHER' as const;
  return { statement: range, within: { ...outerRange, kind } };
}

/**
 * Every call, construction, callback hand-over and module load of the indexed
 * files, tied to the symbol it reaches wherever the source shows that
 * statically. A callee that depends on a parameter, a computed member or any
 * other run-time value is recorded as unresolved, never guessed.
 */
export function buildCallEdges(
  input: GraphInput, moduleEdges: readonly (ModuleEdge & { node: t.Node; path: NodePath })[],
): { edges: IndexedCallEdge[]; resolver: ValueResolver; failedCalls: number } {
  const resolver = createValueResolver(input);
  const edges: IndexedCallEdge[] = [];
  let failedCalls = 0;
  const byName = new Map<string, ProgramSymbol[]>();
  for (const file of input.files.values()) {
    for (const symbol of file.symbols) {
      const short = symbol.kind === 'MODULE' ? undefined : symbol.name?.split('.').at(-1);
      if (short !== undefined) byName.set(short, [...(byName.get(short) ?? []), symbol]);
    }
  }

  for (const edge of moduleEdges) {
    if (edge.resolution !== 'RESOLVED' || !edge.to) continue;
    const target = input.files.get(fileKey(edge.to));
    const source = input.files.get(fileKey(edge.from));
    if (!target || !source) continue;
    const dynamic = edge.kind === 'DYNAMIC_IMPORT';
    const caller = source.symbols.find((symbol) => symbol.id === edge.inSymbolId) ?? source.module;
    // A dynamic import finishes after the current run; a forced exit after it can stop the load.
    const stopped = dynamic && caller.terminatorLines.some((line) => line > edge.statement.startLine);
    const { within } = siteOf(edge.path);
    edges.push({
      callerId: edge.inSymbolId, calleeId: target.module.id, calleeName: edge.to.filePath, kind: 'MODULE_LOAD', site: edge.statement, links: [],
      evidence: !dynamic ? 'CONFIRMED' : stopped ? 'PROBABLE' : 'CONFIRMED_ASYNC', asyncBoundary: dynamic,
      ...(within === undefined ? {} : { within }), ...(stopped ? { unresolvedReason: 'TERMINATION_AFTER_DYNAMIC_IMPORT' } : {}),
    });
  }

  for (const file of input.files.values()) {
    for (const call of file.calls) {
      // A call the resolver cannot work through is left out and counted; the rest of the graph is still built.
      try {
        edgesOfCall(file, call);
      } catch {
        failedCalls += 1;
      }
    }
  }
  for (const edge of edges) {
    edge.basis ??= edge.unresolvedReason
      ?? (edge.kind === 'MODULE_LOAD' ? (edge.asyncBoundary ? 'LITERAL_DYNAMIC_IMPORT' : 'STATIC_IMPORT')
        : edge.kind === 'IMMEDIATE_CALL' ? 'IMMEDIATE_INVOCATION' : edge.evidence === 'PROBABLE' ? 'CALLEE_MAY_CHANGE' : 'STATIC_CALLEE');
  }
  return { edges, resolver, failedCalls };

  function edgesOfCall(file: FileFacts, call: NodePath<t.CallExpression | t.NewExpression>): void {
    {
      if (call.isCallExpression() && loadCall(call)) return;
      const caller = resolver.symbolAt(file, call);
      const { statement, within } = siteOf(call);
      if (!statement) return;
      const site = resolver.statement(file, statement);
      const base = { callerId: caller.id, site, ...(within === undefined ? {} : { within }) };
      const calleePath = call.get('callee') as NodePath;
      let callee: Resolved | undefined;

      if (calleePath.isFunction()) {
        const symbol = file.symbolOfFunction.get(calleePath.node);
        if (symbol) {
          edges.push({ ...base, calleeId: symbol.id, ...(symbol.name === undefined ? {} : { calleeName: symbol.name }),
            kind: 'IMMEDIATE_CALL', links: [], evidence: 'CONFIRMED', callbackKind: 'IMMEDIATE_INVOCATION', asyncBoundary: false, invocation: { path: call, file, argumentOffset: 0 } });
        }
      } else {
        // `fn.call(thisArg, …)` and `fn.apply(thisArg, …)` run `fn`.
        const viaCall = calleePath.isMemberExpression() && !calleePath.node.computed && t.isIdentifier(calleePath.node.property)
          && (calleePath.node.property.name === 'call' || calleePath.node.property.name === 'apply') ? calleePath.node.property.name : undefined;
        const direct = viaCall === undefined ? undefined : resolver.expression(calleePath.get('object') as NodePath, file);
        const viaFunction = direct?.value.kind === 'FUNCTION';
        callee = viaFunction ? direct : resolver.expression(calleePath, file);
        const name = memberPath(calleePath.node)?.join('.');
        const named = name === undefined ? {} : { calleeName: name };
        const invocation = viaFunction
          ? (viaCall === 'call' ? { path: call, file, argumentOffset: 1 } : undefined)
          : { path: call, file, argumentOffset: 0 };
        if (callee.value.kind === 'FUNCTION') {
          edges.push({ ...base, ...named, calleeId: callee.value.symbol.id,
            kind: call.isNewExpression() ? 'CONSTRUCT' : 'CALL', links: callee.links, evidence: callee.evidence, asyncBoundary: false, ...(invocation ? { invocation } : {}) });
        } else if (callee.value.kind === 'CLASS' && call.isNewExpression()) {
          const constructor = callee.value.path.get('body').get('body').find((item) => item.isClassMethod() && item.node.kind === 'constructor');
          const symbol = constructor ? callee.value.file.symbolOfFunction.get(constructor.node) : undefined;
          if (symbol) edges.push({ ...base, ...named, calleeId: symbol.id,
            kind: 'CONSTRUCT', links: callee.links, evidence: callee.evidence, asyncBoundary: false, invocation: { path: call, file, argumentOffset: 0 } });
        } else if (callee.value.kind === 'UNRESOLVED') {
          // `receiver.method()` with a receiver that cannot be resolved: a function of the package with that name is the likely callee.
          const method = calleePath.isMemberExpression() && !calleePath.node.computed && t.isIdentifier(calleePath.node.property) ? calleePath.node.property.name : undefined;
          const guessed = method === undefined || callee.value.reason === 'GLOBAL' || BUILT_IN_METHODS.has(method) || call.isNewExpression() ? []
            : [...(byName.get(method) ?? [])].sort((left, right) => Number(right.filePath === file.ref.filePath) - Number(left.filePath === file.ref.filePath)).slice(0, MAX_NAME_MATCHES);
          for (const symbol of guessed) {
            edges.push({ ...base, ...named, calleeId: symbol.id,
              kind: 'CALL', links: [], evidence: 'PROBABLE', asyncBoundary: false, basis: 'NAME_MATCH', invocation: { path: call, file, argumentOffset: 0 } });
          }
          if (guessed.length === 0 && !['GLOBAL', 'CALL_RESULT', 'UNSUPPORTED_EXPRESSION', 'MEMBER_OF_UNSUPPORTED_VALUE'].includes(callee.value.reason)) {
            edges.push({ ...base, ...named, kind: call.isNewExpression() ? 'CONSTRUCT' : 'CALL', links: [], evidence: 'UNRESOLVED', asyncBoundary: false, unresolvedReason: callee.value.reason });
          }
        }
        if (viaFunction) return;
      }

      const args = call.get('arguments') as NodePath[];
      for (const [index, argument] of args.entries()) {
        if (!(argument.isFunction() || argument.isIdentifier() || argument.isMemberExpression())) continue;
        const handed = resolver.expression(argument, file);
        if (handed.value.kind !== 'FUNCTION') continue;
        for (const found of classifyCallback({ call, argumentIndex: index, callback: handed, callee, file, caller, site, resolver })) {
          edges.push({ ...(found.within === undefined && within !== undefined && found.site === site ? { within } : {}), ...found });
        }
      }
    }
  }
}
