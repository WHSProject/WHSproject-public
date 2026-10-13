import { extname } from 'node:path';
import type { ParserPlugin } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { memberPath, parseLenient, rangeOf, statementOf } from '../code-units';
import { fileKey, type FileRef, type LineRange, type ModuleEdgeKind, type ProgramSymbol } from './program-index.contract';
import type { CollectedFile } from './program-files';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

export interface RawImport {
  path: NodePath;
  statement: LineRange;
  kind: ModuleEdgeKind;
  /** Null when the path is not a string literal. */
  specifier: string | null;
  inSymbol: ProgramSymbol;
}

/** One exported name: the statement that exports it and what provides its value. */
export interface ExportDefinition {
  statement: LineRange;
  /** Expression or declaration that is the exported value. */
  value?: NodePath;
  /** Local binding the name refers to (`export { local as name }`). */
  localName?: string;
  reexport?: { specifier: string; name: string | '*' };
}

export interface FileExports {
  named: Map<string, ExportDefinition>;
  default?: ExportDefinition;
  /** `export * from './x'` */
  stars: Array<{ specifier: string; statement: LineRange }>;
}

/** Everything read from one parsed file. Paths stay attached to the AST so bindings can be followed later. */
export interface FileFacts {
  ref: FileRef;
  code: string;
  ast: t.File;
  program: NodePath<t.Program>;
  module: ProgramSymbol;
  symbols: ProgramSymbol[];
  symbolOfFunction: Map<t.Node, ProgramSymbol>;
  functionOfSymbol: Map<string, NodePath<t.Function>>;
  imports: RawImport[];
  exports: FileExports;
  calls: Array<NodePath<t.CallExpression | t.NewExpression>>;
  /** The file assigns or defines `Promise`, `Promise.resolve` or `Promise.prototype.then`. */
  redefinesPromise: boolean;
  nodeCount: number;
}

export type ParseOutcome = { facts: FileFacts; ast: t.File } | { facts: undefined; ast: t.File | undefined; reason: 'SYNTAX_ERROR' | 'TRAVERSAL_FAILED' };

function pluginsFor(filePath: string): ParserPlugin[] {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.ts') return ['typescript'];
  if (extension === '.tsx') return ['typescript', 'jsx'];
  if (extension === '.jsx') return ['jsx'];
  return [];
}

/** Parses with the options the context check already uses; TypeScript and JSX files add only their syntax plugin. */
export function parseSource(code: string, filePath: string): t.File | undefined {
  return parseLenient(code, pluginsFor(filePath));
}

const propertyName = (key: t.Node, computed: boolean): string | undefined => (
  !computed && t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : undefined
);

/** A readable name for a function: its own, the variable or property it is assigned to, or its method key. */
function nameOf(path: NodePath<t.Function>): string | undefined {
  const { node, parentPath: parent } = path;
  if ((t.isFunctionDeclaration(node) || t.isFunctionExpression(node)) && node.id) return node.id.name;
  if (t.isClassMethod(node) || t.isObjectMethod(node) || t.isClassPrivateMethod(node)) {
    const key = t.isPrivateName(node.key) ? node.key.id.name : propertyName(node.key, (node as { computed?: boolean }).computed === true);
    const owner = path.parentPath?.parentPath;
    const className = owner?.isClass() && owner.node.id ? owner.node.id.name : undefined;
    return key === undefined ? undefined : className ? `${className}.${key}` : key;
  }
  if (parent?.isVariableDeclarator() && t.isIdentifier(parent.node.id)) return parent.node.id.name;
  if (parent?.isAssignmentExpression() && parent.node.right === node) return memberPath(parent.node.left)?.join('.');
  if ((parent?.isObjectProperty() || parent?.isClassProperty()) && parent.node.value === node) return propertyName(parent.node.key, parent.node.computed === true);
  return undefined;
}

const TERMINATING_CALLS = new Set(['process.exit', 'process.abort']);
const PROMISE_TARGETS = new Set(['Promise', 'global.Promise', 'globalThis.Promise', 'window.Promise', 'self.Promise', 'Promise.resolve', 'Promise.prototype.then', 'Promise.prototype']);

/** `require(x)` or `import(x)` with `require` unshadowed; the specifier is null unless it is a plain string. */
export function loadCall(path: NodePath<t.CallExpression>): { kind: 'REQUIRE' | 'DYNAMIC_IMPORT'; specifier: string | null } | undefined {
  const { callee, arguments: args } = path.node;
  const dynamicImport = t.isImport(callee);
  if (!dynamicImport && !(t.isIdentifier(callee) && callee.name === 'require' && !path.scope.getBinding('require'))) return undefined;
  const [argument] = args;
  const specifier = t.isStringLiteral(argument) ? argument.value
    : t.isTemplateLiteral(argument) && argument.expressions.length === 0 ? argument.quasis[0]?.value.cooked ?? null : null;
  return { kind: dynamicImport ? 'DYNAMIC_IMPORT' : 'REQUIRE', specifier: args.length === 1 ? specifier : null };
}

/**
 * Reads one file: its functions as symbols, imports, exports and calls. A file
 * with any syntax error is not indexed at all, because recovered code would be
 * a guess. `budget` is the number of AST nodes that may still be visited.
 */
export function readFileFacts(file: CollectedFile, budget: { nodes: number }): ParseOutcome {
  const ast = parseSource(file.code, file.filePath);
  if (!ast || ((ast as { errors?: unknown[] }).errors?.length ?? 0) > 0) return { facts: undefined, ast, reason: 'SYNTAX_ERROR' };
  const ref: FileRef = { artifactId: file.artifactId, filePath: file.filePath };
  const base = fileKey(ref);
  const module: ProgramSymbol = { id: `${base}\u0000<module>`, kind: 'MODULE', ...ref, startLine: 1, endLine: Math.max(1, file.lineCount), terminatorLines: [] };
  const symbols: ProgramSymbol[] = [module];
  const symbolOfFunction = new Map<t.Node, ProgramSymbol>();
  const functionOfSymbol = new Map<string, NodePath<t.Function>>();
  const imports: RawImport[] = [];
  const exports: FileExports = { named: new Map(), stars: [] };
  const calls: Array<NodePath<t.CallExpression | t.NewExpression>> = [];
  let program: NodePath<t.Program> | undefined;
  let redefinesPromise = false;
  let nodeCount = 0;

  const enclosing = (path: NodePath): ProgramSymbol => {
    const fn = path.getFunctionParent();
    return (fn && symbolOfFunction.get(fn.node)) ?? module;
  };
  const statementRange = (path: NodePath): LineRange | undefined => rangeOf(statementOf(path)?.node);
  const addImport = (path: NodePath, kind: ModuleEdgeKind, specifier: string | null, inSymbol: ProgramSymbol) => {
    const statement = statementRange(path);
    if (statement) imports.push({ path, statement, kind, specifier, inSymbol });
  };

  try {
    traverse(ast, {
      enter() {
        nodeCount += 1;
        if (nodeCount > budget.nodes) throw new WorkLimitError();
      },
      Program(path) { program = path; },
      Function(path) {
        const range = rangeOf(path.node);
        if (!range) return;
        const { node, parentPath: parent } = path;
        const name = nameOf(path);
        const kind = t.isClassMethod(node) || t.isObjectMethod(node) || t.isClassPrivateMethod(node) ? 'METHOD' as const
          : (parent?.isCallExpression() || parent?.isNewExpression()) && (parent.node.arguments as t.Node[]).includes(node) ? 'CALLBACK' as const : 'FUNCTION' as const;
        const bodyStart = node.body.loc?.start.line ?? range.startLine;
        const symbol: ProgramSymbol = {
          id: `${base}\u0000${name ?? '<anonymous>'}@${node.loc!.start.line}:${node.loc!.start.column}`,
          kind, ...ref, ...range, ...(name === undefined ? {} : { name }),
          header: { startLine: range.startLine, endLine: Math.min(bodyStart, range.endLine) },
          parentId: enclosing(path).id, terminatorLines: [],
        };
        symbols.push(symbol);
        symbolOfFunction.set(node, symbol);
        functionOfSymbol.set(symbol.id, path);
      },
      ThrowStatement(path) {
        const line = path.node.loc?.start.line;
        if (line !== undefined) enclosing(path).terminatorLines.push(line);
      },
      ImportDeclaration(path) {
        if (path.node.importKind !== 'type') addImport(path, 'IMPORT', path.node.source.value, module);
      },
      ExportAllDeclaration(path) {
        if (path.node.exportKind === 'type') return;
        const statement = rangeOf(path.node);
        addImport(path, 'REEXPORT', path.node.source.value, module);
        if (statement) exports.stars.push({ specifier: path.node.source.value, statement });
      },
      ExportDefaultDeclaration(path) {
        const statement = rangeOf(path.node);
        if (statement) exports.default = { statement, value: path.get('declaration') as NodePath };
      },
      ExportNamedDeclaration(path) {
        const statement = rangeOf(path.node);
        if (!statement || path.node.exportKind === 'type') return;
        const { source } = path.node;
        if (source) addImport(path, 'REEXPORT', source.value, module);
        for (const specifier of path.node.specifiers) {
          const exported = t.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value;
          if (t.isExportNamespaceSpecifier(specifier)) { if (source) exports.named.set(exported, { statement, reexport: { specifier: source.value, name: '*' } }); continue; }
          if (!t.isExportSpecifier(specifier)) continue;
          const definition: ExportDefinition = source
            ? { statement, reexport: { specifier: source.value, name: specifier.local.name } }
            : { statement, localName: specifier.local.name };
          if (exported === 'default') exports.default = definition;
          else exports.named.set(exported, definition);
        }
        const declaration = path.get('declaration');
        if (declaration.isFunctionDeclaration() || declaration.isClassDeclaration()) {
          if (declaration.node.id) exports.named.set(declaration.node.id.name, { statement, value: declaration as NodePath });
        } else if (declaration.isVariableDeclaration()) {
          for (const declarator of declaration.get('declarations')) {
            const { id } = declarator.node;
            if (t.isIdentifier(id)) exports.named.set(id.name, { statement, localName: id.name });
          }
        }
      },
      AssignmentExpression(path) {
        const target = memberPath(path.node.left)?.join('.');
        if (target === undefined) return;
        if (PROMISE_TARGETS.has(target) || target.startsWith('Promise.prototype.')) redefinesPromise = true;
        // CommonJS exports are read at the top level only; an export made inside a function is not established.
        const statement = path.parentPath;
        if (!statement.isExpressionStatement() || !statement.parentPath.isProgram() || path.node.operator !== '=') return;
        const range = rangeOf(statement.node);
        if (!range) return;
        const value = path.get('right') as NodePath;
        if (target === 'module.exports') exports.default = { statement: range, value };
        else if (target.startsWith('module.exports.') && target.split('.').length === 3) exports.named.set(target.split('.')[2]!, { statement: range, value });
        else if (target.startsWith('exports.') && target.split('.').length === 2 && !path.scope.getBinding('exports')) exports.named.set(target.split('.')[1]!, { statement: range, value });
      },
      CallExpression(path) {
        calls.push(path);
        const callee = memberPath(path.node.callee)?.join('.');
        if (callee !== undefined && TERMINATING_CALLS.has(callee)) {
          const line = path.node.loc?.start.line;
          if (line !== undefined) enclosing(path).terminatorLines.push(line);
        }
        if (callee === 'Object.defineProperty' || callee === 'Object.defineProperties' || callee === 'Reflect.defineProperty') {
          const first = path.node.arguments[0];
          const owner = first && t.isExpression(first) ? memberPath(first)?.join('.') : undefined;
          if (owner !== undefined && (PROMISE_TARGETS.has(owner) || ['global', 'globalThis', 'window', 'self'].includes(owner))) redefinesPromise = true;
        }
        const load = loadCall(path);
        if (load) addImport(path, load.kind, load.specifier, enclosing(path));
      },
      NewExpression(path) { calls.push(path); },
    });
  } catch (error) {
    if (error instanceof WorkLimitError) throw error;
    return { facts: undefined, ast, reason: 'TRAVERSAL_FAILED' };
  }
  if (!program) return { facts: undefined, ast, reason: 'TRAVERSAL_FAILED' };
  if (program.scope.hasOwnBinding('Promise')) redefinesPromise = true;
  budget.nodes -= nodeCount;
  return { ast, facts: { ref, code: file.code, ast, program, module, symbols, symbolOfFunction, functionOfSymbol, imports, exports, calls, redefinesPromise, nodeCount } };
}

/** Thrown when the node budget of the build is used up; the build stops reading files there. */
export class WorkLimitError extends Error {
  constructor() { super('Program index work limit reached'); }
}
