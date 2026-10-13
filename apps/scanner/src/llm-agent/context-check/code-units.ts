import { parse, type ParserPlugin } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;

export interface CodeRange { startLine: number; endLine: number }

/** One complete statement: what a candidate offers, never a fragment of it. */
export interface CodeUnit extends CodeRange {
  /** Binding or exported name the statement defines, when there is one. */
  symbol?: string;
  /** Top-level statement that runs when the file is loaded. */
  executable?: boolean;
}

/** A static relative import the analyzed lines use; `symbol` null means the imported name is not known. */
export interface ImportRef { specifier: string; symbol: string | null }

/**
 * What the covered lines of one file link to directly. `imports` holds every
 * static relative import of the file, the used ones first; `usedImports` holds
 * only those the covered lines use, with the imported name when it is known.
 * `parsed` is false when the file did not parse; then only `imports`, found by
 * pattern, is filled.
 */
export interface FileLinks {
  definitions: CodeUnit[];
  functions: CodeUnit[];
  imports: string[];
  usedImports: ImportRef[];
  parsed: boolean;
}

const isRelative = (specifier: string): boolean => specifier.startsWith('./') || specifier.startsWith('../');

/**
 * Parsed files kept for one candidate generation, so a file is parsed once
 * however many candidates look at it. Create one per run; it is never shared.
 */
export interface ParseCache { get(code: string): t.File | undefined; /** Stores a file that was already parsed elsewhere, so it is not parsed again. */ set(code: string, ast: t.File | undefined): void }

export function createParseCache(): ParseCache {
  const parsed = new Map<string, t.File | undefined>();
  return {
    get(code) {
      if (!parsed.has(code)) parsed.set(code, parseFresh(code));
      return parsed.get(code);
    },
    set(code, ast) { parsed.set(code, ast); },
  };
}

/**
 * A file without import or export is CommonJS and runs in sloppy mode: `package`
 * is a name there and a top-level `return` ends the module. It is read again
 * without the strict rules when only those raised errors.
 */
export function parseLenient(code: string, plugins: ParserPlugin[] = []): t.File | undefined {
  const options = { errorRecovery: true, allowReturnOutsideFunction: true, ...(plugins.length === 0 ? {} : { plugins }) };
  const errorsOf = (ast: t.File): number => (ast as { errors?: unknown[] }).errors?.length ?? 0;
  try {
    const ast = parse(code, { ...options, sourceType: 'unambiguous' });
    if (errorsOf(ast) === 0 || ast.program.sourceType !== 'script') return ast;
    try {
      const sloppy = parse(code, { ...options, sourceType: 'script', strictMode: false });
      return errorsOf(sloppy) < errorsOf(ast) ? sloppy : ast;
    } catch {
      return ast;
    }
  } catch {
    return undefined;
  }
}

const parseFresh = (code: string): t.File | undefined => parseLenient(code);

const parseModule = (code: string, cache?: ParseCache): t.File | undefined => (cache ? cache.get(code) : parseFresh(code));

function programPath(ast: t.File): NodePath<t.Program> | undefined {
  let program: NodePath<t.Program> | undefined;
  traverse(ast, { Program(path) { program = path; path.stop(); } });
  return program;
}

export const rangeOf = (node: t.Node | null | undefined): CodeRange | undefined => (
  node?.loc ? { startLine: node.loc.start.line, endLine: node.loc.end.line } : undefined
);

/** The complete statement holding `path`, including an `export` that wraps it. */
export function statementOf(path: NodePath): NodePath | null {
  const statement = path.isStatement() ? path : path.getStatementParent();
  if (!statement) return null;
  const parent = statement.parentPath;
  return parent && (parent.isExportNamedDeclaration() || parent.isExportDefaultDeclaration()) ? parent : statement;
}

export function requireSpecifier(node: t.Node | null | undefined): string | undefined {
  if (!t.isCallExpression(node) || node.arguments.length !== 1) return undefined;
  const [argument] = node.arguments;
  const staticCall = (t.isIdentifier(node.callee) && node.callee.name === 'require') || t.isImport(node.callee);
  return staticCall && t.isStringLiteral(argument) && isRelative(argument.value) ? argument.value : undefined;
}

const keyName = (key: t.Node): string | undefined => (t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : undefined);

/** Names a `require` result is taken under: the whole module (`default`), destructured names, or one member. */
function requiredNames(call: NodePath): Array<string | null> {
  const parent = call.parentPath;
  if (parent?.isVariableDeclarator() && parent.node.init === call.node) {
    const { id } = parent.node;
    if (t.isIdentifier(id)) return ['default'];
    if (t.isObjectPattern(id)) {
      const names = id.properties.map((property) => (t.isObjectProperty(property) ? keyName(property.key) : undefined));
      return names.every((name): name is string => name !== undefined) && names.length > 0 ? names : [null];
    }
    return [null];
  }
  if (parent?.isMemberExpression() && parent.node.object === call.node && !parent.node.computed && t.isIdentifier(parent.node.property)) {
    return [parent.node.property.name];
  }
  return [null];
}

/** Static relative specifiers found without a parser; used when the file does not parse. */
export function importsByPattern(code: string): string[] {
  const specifiers = [...code.matchAll(/(?:require|import)\s*\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)|from\s+(['"])(\.{1,2}\/[^'"\n]+)\3/gu)]
    .map((match) => match[2] ?? match[4] ?? '');
  return [...new Set(specifiers.filter(Boolean))];
}

function distance(range: CodeRange, covered: readonly CodeRange[]): number {
  return Math.min(...covered.map((item) => (range.endLine < item.startLine ? item.startLine - range.endLine : Math.max(0, range.startLine - item.endLine))));
}

/**
 * Finds what the covered lines of one file link to directly: the complete
 * statements that declare or assign the identifiers they use, the local
 * functions they reference, and the static relative imports they use. One hop
 * only. A statement that lies wholly inside the covered lines is not returned.
 */
export function analyzeFileLinks(code: string, covered: readonly CodeRange[], cache?: ParseCache): FileLinks {
  const ast = parseModule(code, cache);
  const failed: FileLinks = { definitions: [], functions: [], imports: importsByPattern(code), usedImports: [], parsed: false };
  if (!ast) return failed;
  const inCovered = (line: number) => covered.some((range) => line >= range.startLine && line <= range.endLine);
  const definitions = new Map<string, CodeUnit>();
  const functions = new Map<string, CodeUnit>();
  const usedImports = new Map<string, ImportRef>();
  const otherImports: string[] = [];
  const seenBindings = new Set<Binding>();

  const add = (target: Map<string, CodeUnit>, path: NodePath | null | undefined, symbol: string) => {
    const statement = path ? statementOf(path) : null;
    const range = rangeOf(statement?.node);
    if (!range) return;
    if (covered.some((item) => range.startLine >= item.startLine && range.endLine <= item.endLine)) return;
    const key = `${range.startLine}:${range.endLine}`;
    if (!target.has(key)) target.set(key, { ...range, symbol });
  };
  const useImport = (specifier: string, symbol: string | null) => {
    const key = `${specifier}\u0000${symbol ?? ''}`;
    if (!usedImports.has(key)) usedImports.set(key, { specifier, symbol });
  };
  const collect = (binding: Binding) => {
    if (seenBindings.has(binding)) return;
    seenBindings.add(binding);
    const name = binding.identifier.name;
    const { node } = binding.path;
    if (t.isFunctionDeclaration(node)) add(functions, binding.path, name);
    else if (t.isVariableDeclarator(node)) {
      const specifier = requireSpecifier(node.init);
      if (specifier !== undefined) {
        if (t.isIdentifier(node.id)) useImport(specifier, 'default');
        else if (t.isObjectPattern(node.id)) {
          const property = node.id.properties.find((item) => t.isObjectProperty(item) && t.isIdentifier(item.value) && item.value.name === name);
          useImport(specifier, property && t.isObjectProperty(property) ? keyName(property.key) ?? null : null);
        } else useImport(specifier, null);
      }
      if (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init)) add(functions, binding.path, name);
      else add(definitions, binding.path, name);
    } else if (t.isImportSpecifier(node) || t.isImportDefaultSpecifier(node) || t.isImportNamespaceSpecifier(node)) {
      const declaration = binding.path.parentPath?.node;
      if (t.isImportDeclaration(declaration) && isRelative(declaration.source.value)) {
        const symbol = t.isImportDefaultSpecifier(node) ? 'default' : t.isImportSpecifier(node) ? keyName(node.imported) ?? null : null;
        useImport(declaration.source.value, symbol);
      }
    }
    for (const violation of binding.constantViolations) {
      if (violation.isAssignmentExpression()) add(definitions, violation, name);
    }
  };

  try {
    traverse(ast, {
      Identifier(path) {
        const line = path.node.loc?.start.line;
        if (line === undefined || !inCovered(line) || !path.isReferencedIdentifier()) return;
        const binding = path.scope.getBinding(path.node.name);
        if (binding) collect(binding);
      },
      ImportDeclaration(path) {
        if (isRelative(path.node.source.value)) otherImports.push(path.node.source.value);
      },
      CallExpression(path) {
        const specifier = requireSpecifier(path.node);
        if (specifier === undefined) return;
        const line = path.node.loc?.start.line;
        if (line !== undefined && inCovered(line)) for (const symbol of requiredNames(path)) useImport(specifier, symbol);
        else otherImports.push(specifier);
      },
    });
  } catch {
    return failed;
  }

  const byDistance = (units: Map<string, CodeUnit>) => [...units.values()]
    .sort((left, right) => distance(left, covered) - distance(right, covered) || left.startLine - right.startLine);
  const used = [...usedImports.values()];
  return {
    definitions: byDistance(definitions),
    functions: byDistance(functions),
    imports: [...new Set([...used.map((ref) => ref.specifier), ...otherImports])],
    usedImports: used,
    parsed: true,
  };
}

const sortUnits = (units: readonly CodeUnit[]): CodeUnit[] => {
  const unique = new Map<string, CodeUnit>();
  for (const unit of units) {
    const key = `${unit.startLine}:${unit.endLine}`;
    const existing = unique.get(key);
    unique.set(key, existing ? { ...existing, executable: existing.executable === true || unit.executable === true } : unit);
  }
  return [...unique.values()].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
};

export function memberPath(node: t.Node): string[] | undefined {
  if (t.isIdentifier(node)) return [node.name];
  if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
    const object = memberPath(node.object);
    return object ? [...object, node.property.name] : undefined;
  }
  return undefined;
}

/** `module.exports = …` → ['default']; `module.exports.x = …` or `exports.x = …` → ['x']; otherwise undefined. */
function commonJsExport(statement: t.Statement): { names: string[]; value: t.Expression } | undefined {
  if (!t.isExpressionStatement(statement) || !t.isAssignmentExpression(statement.expression) || statement.expression.operator !== '=') return undefined;
  const target = memberPath(statement.expression.left);
  const value = statement.expression.right;
  if (!target) return undefined;
  if (target.join('.') === 'module.exports') return { names: ['default'], value };
  if (target.length === 3 && target[0] === 'module' && target[1] === 'exports') return { names: [target[2]!], value };
  if (target.length === 2 && target[0] === 'exports') return { names: [target[1]!], value };
  return undefined;
}

export interface ExportLookup {
  units: CodeUnit[];
  /** True when the units define the requested name; false when they are the module's export statements as a fallback. */
  matched: boolean;
}

/**
 * The statements that define what a module exports under `symbol` ('default'
 * for `module.exports` or `export default`): the export statement and, when it
 * exports a local name, that name's declaration. Re-exports from other files and
 * renamed exports are not followed. When the name cannot be found, or `symbol`
 * is null, the module's export statements are returned instead. Undefined when
 * the file does not parse.
 */
export function exportUnits(code: string, symbol: string | null, cache?: ParseCache): ExportLookup | undefined {
  const ast = parseModule(code, cache);
  const program = ast ? programPath(ast) : undefined;
  if (!ast || !program) return undefined;
  const definitionOf = (name: string): CodeUnit[] => {
    const binding = program.scope.getBinding(name);
    const statement = binding ? statementOf(binding.path) : null;
    const range = rangeOf(statement?.node);
    return range ? [{ ...range, symbol: name }] : [];
  };
  const valueDefinition = (value: t.Node | null | undefined): CodeUnit[] => (t.isIdentifier(value) ? definitionOf(value.name) : []);

  const matched: CodeUnit[] = [];
  const exportStatements: CodeUnit[] = [];
  for (const statement of ast.program.body) {
    const range = rangeOf(statement);
    if (!range) continue;
    const commonJs = commonJsExport(statement);
    if (commonJs) {
      exportStatements.push(range);
      if (symbol === null) continue;
      if (commonJs.names.includes(symbol)) matched.push({ ...range, symbol }, ...valueDefinition(commonJs.value));
      else if (commonJs.names[0] === 'default' && t.isObjectExpression(commonJs.value)) {
        const property = commonJs.value.properties.find((item) => t.isObjectProperty(item) && keyName(item.key) === symbol);
        if (property && t.isObjectProperty(property)) matched.push({ ...range, symbol }, ...valueDefinition(property.value));
      }
      continue;
    }
    if (t.isExportDefaultDeclaration(statement)) {
      exportStatements.push(range);
      if (symbol === 'default') matched.push({ ...range, symbol }, ...valueDefinition(statement.declaration));
      continue;
    }
    if (t.isExportNamedDeclaration(statement)) {
      if (statement.source) continue;
      exportStatements.push(range);
      if (symbol === null) continue;
      const declared = statement.declaration;
      const declares = t.isVariableDeclaration(declared)
        ? declared.declarations.some((item) => t.isIdentifier(item.id) && item.id.name === symbol)
        : (t.isFunctionDeclaration(declared) || t.isClassDeclaration(declared)) && declared.id?.name === symbol;
      if (declares) matched.push({ ...range, symbol });
      const specifier = statement.specifiers.find((item) => t.isExportSpecifier(item) && keyName(item.exported) === symbol && item.local.name === symbol);
      if (specifier) matched.push({ ...range, symbol }, ...definitionOf(symbol));
    }
  }
  return matched.length > 0 ? { units: sortUnits(matched), matched: true } : { units: sortUnits(exportStatements), matched: false };
}

function hasExecution(node: t.Node | null | undefined): boolean {
  if (!node) return false;
  if (requireSpecifier(node) !== undefined || (t.isCallExpression(node) && t.isIdentifier(node.callee) && node.callee.name === 'require')) return false;
  let found = false;
  t.traverseFast(node, (child) => {
    if (found || t.isFunction(child)) return;
    if ((t.isCallExpression(child) && !(t.isIdentifier(child.callee) && child.callee.name === 'require')) || t.isNewExpression(child) || t.isAwaitExpression(child)) found = true;
  });
  return found;
}

/** Whether a top-level statement does something when the file is loaded, rather than only declaring or exporting. */
function isExecutable(statement: t.Statement): boolean {
  if (t.isExpressionStatement(statement)) return commonJsExport(statement) === undefined || hasExecution((statement.expression as t.AssignmentExpression).right);
  if (t.isVariableDeclaration(statement)) return statement.declarations.some((item) => hasExecution(item.init));
  return t.isIfStatement(statement) || t.isForStatement(statement) || t.isForInStatement(statement) || t.isForOfStatement(statement)
    || t.isWhileStatement(statement) || t.isDoWhileStatement(statement) || t.isTryStatement(statement) || t.isSwitchStatement(statement)
    || t.isLabeledStatement(statement) || t.isBlockStatement(statement) || t.isThrowStatement(statement);
}

/**
 * What a lifecycle script or entry point runs when it loads a file: its
 * top-level executable statements and the local declarations those statements
 * reference directly. Undefined when the file does not parse.
 */
export function entryUnits(code: string, cache?: ParseCache): CodeUnit[] | undefined {
  const ast = parseModule(code, cache);
  if (!ast) return undefined;
  const executable = ast.program.body
    .filter(isExecutable)
    .map((statement) => rangeOf(statement))
    .filter((range): range is CodeRange => range !== undefined)
    .map((range) => ({ ...range, executable: true }));
  if (executable.length === 0) return [];
  const links = analyzeFileLinks(code, executable, cache);
  return sortUnits([...executable, ...links.definitions, ...links.functions]);
}

const COMMENT_ONLY_LINE = /^\s*(?:\/\/.*|\/\*.*|\*.*|\*\/\s*)?$/u;

/**
 * The lines of a file up to `maxLines`, without leading and trailing blank or
 * comment-only lines. The fallback when a file cannot be read as statements.
 */
export function trimmedFileRange(lines: readonly string[], maxLines: number): CodeRange | undefined {
  const last = Math.min(lines.length, maxLines);
  let start = 1;
  let end = last;
  while (start <= end && COMMENT_ONLY_LINE.test(lines[start - 1] ?? '')) start += 1;
  while (end >= start && COMMENT_ONLY_LINE.test(lines[end - 1] ?? '')) end -= 1;
  return start <= end ? { startLine: start, endLine: end } : undefined;
}

/** False when the lines hold nothing but comments, whitespace and punctuation. */
export function hasMeaningfulCode(lines: readonly string[]): boolean {
  const withoutComments = lines.join('\n').replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ');
  return withoutComments.replace(/[\s{}[\]();,]/gu, '').length > 0;
}

/** The statement whose lines are exactly `range`, if any. */
function statementAt(ast: t.File, range: CodeRange): NodePath | undefined {
  let found: NodePath | undefined;
  traverse(ast, {
    enter(path) {
      if (found || !path.isStatement()) return;
      const lines = rangeOf(path.node);
      if (lines && lines.startLine === range.startLine && lines.endLine === range.endLine) { found = path; path.stop(); }
    },
  });
  return found;
}

/**
 * Whether the statement a Finding belongs to passes nothing but literals: every
 * name it reads is what a call is made on. A function passed as an argument is
 * not a value and is not looked into. False when the statement cannot be read.
 */
export function statementUsesOnlyLiterals(code: string, range: CodeRange, cache?: ParseCache): boolean {
  const ast = parseModule(code, cache);
  const located = ast ? findingStatement(code, range, cache) : undefined;
  const statement = ast && located ? statementAt(ast, located) : undefined;
  if (!statement || !(statement.isExpressionStatement() || statement.isVariableDeclaration() || statement.isReturnStatement())) return false;
  let literalsOnly = true;
  let calls = 0;
  statement.traverse({
    Function(path) { path.skip(); },
    CallExpression() { calls += 1; },
    'ThisExpression|AssignmentExpression|UpdateExpression|SpreadElement|TaggedTemplateExpression'(path) { literalsOnly = false; path.stop(); },
    Identifier(path) {
      if (!path.isReferencedIdentifier()) return;
      // The root of a callee chain such as `https` in `https.get(...).end()` names what is called, not a value passed.
      let node: NodePath = path;
      while (node.parentPath?.isMemberExpression() && node.parentPath.node.object === node.node) node = node.parentPath;
      if (node.parentPath?.isCallExpression() && node.parentPath.node.callee === node.node) return;
      literalsOnly = false;
      path.stop();
    },
  });
  return literalsOnly && calls > 0;
}

/** Where a function an INPUT value statement calls is defined: in the same file, or behind a static import. */
export type CalledFunction = { kind: 'LOCAL'; unit: CodeUnit } | { kind: 'IMPORT'; ref: ImportRef & { symbol: string } };

/**
 * A user-defined function a call reaches by name: a local function declaration
 * or function-valued variable, or a name bound to a static relative import.
 */
function userFunctionOf(path: NodePath<t.CallExpression>): CalledFunction | undefined {
  const { callee } = path.node;
  if (!t.isIdentifier(callee)) return undefined;
  const binding = path.scope.getBinding(callee.name);
  if (!binding) return undefined;
  const { node } = binding.path;
  if (t.isFunctionDeclaration(node) || (t.isVariableDeclarator(node) && (t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init)))) {
    const range = rangeOf(statementOf(binding.path)?.node);
    return range ? { kind: 'LOCAL', unit: { ...range, symbol: callee.name } } : undefined;
  }
  if (t.isVariableDeclarator(node)) {
    const specifier = requireSpecifier(node.init);
    if (specifier === undefined) return undefined;
    if (t.isIdentifier(node.id)) return { kind: 'IMPORT', ref: { specifier, symbol: 'default' } };
    if (t.isObjectPattern(node.id)) {
      const property = node.id.properties.find((item) => t.isObjectProperty(item) && t.isIdentifier(item.value) && item.value.name === callee.name);
      const symbol = property && t.isObjectProperty(property) ? keyName(property.key) : undefined;
      return symbol ? { kind: 'IMPORT', ref: { specifier, symbol } } : undefined;
    }
    return undefined;
  }
  const declaration = binding.path.parentPath?.node;
  if ((t.isImportDefaultSpecifier(node) || t.isImportSpecifier(node)) && t.isImportDeclaration(declaration) && isRelative(declaration.source.value)) {
    const symbol = t.isImportDefaultSpecifier(node) ? 'default' : keyName(node.imported);
    return symbol ? { kind: 'IMPORT', ref: { specifier: declaration.source.value, symbol } } : undefined;
  }
  return undefined;
}

/**
 * Whether the calls inside `path` stay within what is visible: calls to globals
 * and to built-in modules are direct sources; a call to another user-defined
 * function or through an imported user module, a computed or otherwise dynamic
 * callee, and a `require` of a non-literal all lead to code that is not shown.
 */
function callsStayVisible(path: NodePath, self?: string): boolean {
  if (path.isCallExpression() && !callVisible(path, self)) return false;
  let visible = true;
  path.traverse({
    CallExpression(call) {
      if (visible && !callVisible(call, self)) visible = false;
    },
  });
  return visible;
}

function callVisible(call: NodePath<t.CallExpression>, self?: string): boolean {
  const { callee } = call.node;
  if (t.isIdentifier(callee)) {
    // require('x') with a literal is an import; anything else picks the module at run time.
    if (callee.name === 'require') return t.isStringLiteral(call.node.arguments[0]);
    if (callee.name === self) return true;
    const binding = call.scope.getBinding(callee.name);
    // A global (fetch, setTimeout, ...) is a direct source.
    if (!binding) return true;
    const { node } = binding.path;
    // Calling a built-in module itself, e.g. `const fetch = require('node-fetch'); fetch()`.
    return t.isVariableDeclarator(node) && t.isCallExpression(node.init) && t.isIdentifier(node.init.callee) && node.init.callee.name === 'require'
      && t.isStringLiteral(node.init.arguments[0]) && !isRelative(node.init.arguments[0].value);
  }
  if (t.isMemberExpression(callee)) {
    if (callee.computed) return false;
    const root = memberRoot(callee);
    if (!root) return true;
    const binding = call.scope.getBinding(root.name);
    const node = binding?.path.node;
    const declaration = binding?.path.parentPath?.node;
    // A method of a user module (`helper.make()`) is code that is not shown.
    return !((t.isVariableDeclarator(node) && requireSpecifier(node.init) !== undefined)
      || (t.isImportDeclaration(declaration) && isRelative(declaration.source.value)));
  }
  return false;
}

function memberRoot(node: t.Expression | t.Super): t.Identifier | undefined {
  if (t.isIdentifier(node)) return node;
  if (t.isMemberExpression(node)) return memberRoot(node.object as t.Expression);
  if (t.isCallExpression(node)) return memberRoot(node.callee as t.Expression);
  return undefined;
}

/**
 * What an INPUT value statement (a declaration or a direct assignment) shows
 * about where its value comes from:
 * - `CALL`: the value is the result of one statically identified user-defined
 *   function, whose definition has to be shown as well;
 * - `DIRECT`: literals, globals, built-in modules and imported bindings only;
 * - `UNRESOLVED`: it depends on other user-defined functions or dynamic calls.
 */
export type InputValueSource = { source: 'DIRECT' | 'UNRESOLVED' } | { source: 'CALL'; target: CalledFunction };

export function inputValueSource(code: string, unit: CodeRange, cache?: ParseCache): InputValueSource {
  const ast = parseModule(code, cache);
  const statement = ast ? statementAt(ast, unit) : undefined;
  if (!statement) return { source: 'UNRESOLVED' };
  const values: NodePath[] = [];
  if (statement.isVariableDeclaration()) {
    for (const declarator of statement.get('declarations')) {
      const init = declarator.get('init');
      if (init.node) values.push(init as NodePath);
    }
  } else if (statement.isExpressionStatement() && t.isAssignmentExpression(statement.node.expression) && statement.node.expression.operator === '='
    && t.isIdentifier(statement.node.expression.left)) {
    values.push(statement.get('expression').get('right') as NodePath);
  } else {
    return { source: 'UNRESOLVED' };
  }
  if (values.length === 1) {
    let value = values[0]!;
    if (value.isAwaitExpression()) value = value.get('argument') as NodePath;
    if (value.isCallExpression()) {
      const target = userFunctionOf(value);
      if (target) {
        const argumentsVisible = value.get('arguments').every((argument) => callsStayVisible(argument as NodePath));
        return argumentsVisible ? { source: 'CALL', target } : { source: 'UNRESOLVED' };
      }
    }
  }
  return values.every((value) => callsStayVisible(value)) ? { source: 'DIRECT' } : { source: 'UNRESOLVED' };
}

/** Whether a function definition shows its value without relying on other user-defined functions or dynamic calls. */
export function definitionIsSelfContained(code: string, units: readonly CodeUnit[], cache?: ParseCache): boolean {
  const ast = parseModule(code, cache);
  if (!ast) return false;
  return units.every((unit) => {
    const statement = statementAt(ast, unit);
    return statement !== undefined && callsStayVisible(statement, unit.symbol);
  });
}

export interface ImportStatement { unit: CodeRange; specifier: string }

/**
 * The static relative imports that the given statements reach: a `require` or
 * dynamic `import` with a literal relative path inside them, the `require` or
 * `import` statement that declares a name they reference, and any top-level
 * side-effect `import './x'` (it runs whenever the file loads). Each comes with
 * the complete statement that holds it. Undefined when the file does not parse.
 */
export function relativeImportsReachedBy(code: string, units: readonly CodeRange[], cache?: ParseCache): ImportStatement[] | undefined {
  const ast = parseModule(code, cache);
  if (!ast) return undefined;
  const inUnits = (line: number | undefined) => line !== undefined && units.some((unit) => line >= unit.startLine && line <= unit.endLine);
  const found = new Map<string, ImportStatement>();
  const add = (path: NodePath | null | undefined, specifier: string) => {
    const unit = rangeOf((path ? statementOf(path) : null)?.node);
    if (unit) found.set(`${unit.startLine}:${unit.endLine}:${specifier}`, { unit, specifier });
  };
  try {
    traverse(ast, {
      Identifier(path) {
        if (!inUnits(path.node.loc?.start.line) || !path.isReferencedIdentifier()) return;
        const binding = path.scope.getBinding(path.node.name);
        if (!binding) return;
        const { node } = binding.path;
        const specifier = t.isVariableDeclarator(node) ? requireSpecifier(node.init) : undefined;
        if (specifier !== undefined) { add(binding.path, specifier); return; }
        const declaration = binding.path.parentPath;
        if ((t.isImportSpecifier(node) || t.isImportDefaultSpecifier(node) || t.isImportNamespaceSpecifier(node))
          && declaration?.isImportDeclaration() && isRelative(declaration.node.source.value)) {
          add(declaration, declaration.node.source.value);
        }
      },
      CallExpression(path) {
        const specifier = requireSpecifier(path.node);
        if (specifier !== undefined && inUnits(path.node.loc?.start.line)) add(path, specifier);
      },
      ImportDeclaration(path) {
        if (path.node.specifiers.length === 0 && isRelative(path.node.source.value)) add(path, path.node.source.value);
      },
    });
  } catch {
    return undefined;
  }
  return [...found.values()].sort((left, right) => left.unit.startLine - right.unit.startLine);
}

export interface ImportedCall { unit: CodeRange; ref: ImportRef & { symbol: string } }

/**
 * Calls inside the given statements to a function that a static relative
 * import names (`const { start } = require('./runner'); start();`), each with
 * the given statement that holds it. Calls through a module object, computed or
 * dynamic callees, and local functions are not included.
 */
export function importedCalls(code: string, units: readonly CodeRange[], cache?: ParseCache): ImportedCall[] {
  const ast = parseModule(code, cache);
  if (!ast) return [];
  const unitAt = (line: number | undefined) => (line === undefined ? undefined : units.find((unit) => line >= unit.startLine && line <= unit.endLine));
  const found = new Map<string, ImportedCall>();
  try {
    traverse(ast, {
      CallExpression(path) {
        const unit = unitAt(path.node.loc?.start.line);
        if (!unit) return;
        const target = userFunctionOf(path);
        if (target?.kind !== 'IMPORT') return;
        const key = `${target.ref.specifier}\u0000${target.ref.symbol}`;
        if (!found.has(key)) found.set(key, { unit: { startLine: unit.startLine, endLine: unit.endLine }, ref: target.ref });
      },
    });
  } catch {
    return [];
  }
  return [...found.values()];
}

/**
 * Whether the given lines hold code that runs when the file is loaded: the
 * file parses without errors, the lines hold at least one statement, and they
 * do not overlap any function, method or class. A call whose callback starts on
 * the same lines does not count, so the answer errs towards false.
 */
export function runsAtLoad(code: string, range: CodeRange, cache?: ParseCache): boolean {
  const ast = parseModule(code, cache);
  if (!ast || ((ast as { errors?: unknown[] }).errors?.length ?? 0) > 0) return false;
  let hasStatement = false;
  let enclosed = false;
  try {
    traverse(ast, {
      enter(path) {
        const { loc } = path.node;
        if (!loc) return;
        if (loc.start.line > range.endLine || loc.end.line < range.startLine) { path.skip(); return; }
        if (path.isFunction() || path.isClass()) { enclosed = true; path.stop(); return; }
        if (path.isStatement()) hasStatement = true;
      },
    });
  } catch {
    return false;
  }
  return hasStatement && !enclosed;
}

/**
 * Where a Finding sits relative to what runs when its file is loaded.
 * `TOP_LEVEL`: outside every function. `CALLED_AT_LOAD`: inside functions that
 * are each called, by name or immediately, on a path that starts at the top
 * level. `CALLBACK`: on that path at least one function is only handed to a
 * call as a callback, so it is registered but when it fires is not established.
 * `EXPORTED_NOT_CALLED`: the function is exported and never called in this
 * file. `UNKNOWN`: a method, a dynamic or unresolved call, a file that does not
 * parse, or no line number.
 */
export type FindingPosition = 'TOP_LEVEL' | 'CALLED_AT_LOAD' | 'CALLBACK' | 'EXPORTED_NOT_CALLED' | 'UNKNOWN';

/** One step between the file load and the Finding, outermost first. */
export interface ExecutionStep {
  kind: 'CALL' | 'IMMEDIATE_CALL' | 'CALLBACK_REGISTRATION' | 'EXPORT' | 'UNKNOWN';
  /** Called function, or the call the callback is handed to. */
  symbol?: string;
  line?: number;
  /** The complete statement that makes the call or registers the callback. */
  statement?: CodeRange;
  /**
   * The statement that encloses `statement` in the same function or at the top
   * level, when there is one: the call is made only as that statement decides
   * (a condition, a loop, a try block). `RUN_DIRECTLY` is the condition
   * `require.main === module` with the call in its true branch: it holds
   * exactly when the file is run as a script, and not when it is required.
   */
  within?: CodeRange & { kind: 'CONDITION' | 'RUN_DIRECTLY' | 'LOOP' | 'TRY' | 'OTHER' };
  /** The function this step enters. */
  definition?: CodeRange;
}

export interface ExecutionPath {
  position: FindingPosition;
  steps: ExecutionStep[];
  /** A function starts on the Finding's first line and runs past its last line; the Finding is read as the statement that holds it. */
  callbackStartsOnLine?: true;
}

const POSITION_RANK: Record<FindingPosition, number> = { TOP_LEVEL: 0, CALLED_AT_LOAD: 1, CALLBACK: 2, EXPORTED_NOT_CALLED: 3, UNKNOWN: 4 };
const MAX_EXECUTION_STEPS = 6;

/** The least certain of the given positions; UNKNOWN when there are none. */
export function weakestPosition(positions: readonly FindingPosition[]): FindingPosition {
  if (positions.length === 0) return 'UNKNOWN';
  return positions.reduce((worst, position) => (POSITION_RANK[position] > POSITION_RANK[worst] ? position : worst));
}

const positionOf = (steps: readonly ExecutionStep[]): FindingPosition => {
  if (steps.length === 0) return 'TOP_LEVEL';
  if (steps.some((step) => step.kind === 'UNKNOWN')) return 'UNKNOWN';
  if (steps.some((step) => step.kind === 'EXPORT')) return 'EXPORTED_NOT_CALLED';
  return steps.some((step) => step.kind === 'CALLBACK_REGISTRATION') ? 'CALLBACK' : 'CALLED_AT_LOAD';
};

const calleeText = (node: t.Node): string | undefined => memberPath(node)?.join('.');

/** `require.main === module` in either order, and nothing else. */
export function isRunDirectlyTest(test: t.Expression): boolean {
  if (!t.isBinaryExpression(test) || (test.operator !== '===' && test.operator !== '==')) return false;
  const sides = [test.left, test.right].map((side) => memberPath(side)?.join('.'));
  return sides.includes('require.main') && sides.includes('module');
}

/**
 * The static path from the load of a file to the given lines: the calls, by
 * name or immediate, and the callback registrations that lead there. Only what
 * the file itself shows is followed. A function that is exported but not called
 * here, a method, and anything reached dynamically are not taken as run.
 *
 * Findings carry lines, not columns. A function that starts on the Finding's
 * first line and continues past its last line is taken to start there (the
 * Finding is the statement holding it), while a function wholly on those lines
 * is taken to hold the Finding.
 */
export function executionPathTo(code: string, range: CodeRange, cache?: ParseCache): ExecutionPath {
  const unknown: ExecutionPath = { position: 'UNKNOWN', steps: [{ kind: 'UNKNOWN' }] };
  const ast = parseModule(code, cache);
  if (!ast || ((ast as { errors?: unknown[] }).errors?.length ?? 0) > 0) return unknown;

  let innermost: NodePath<t.Function> | undefined;
  let hasStatement = false;
  let startsOnLine = false;
  try {
    traverse(ast, {
      enter(path) {
        const { loc } = path.node;
        if (!loc) return;
        if (loc.start.line > range.endLine || loc.end.line < range.startLine) { path.skip(); return; }
        if (path.isStatement()) hasStatement = true;
        if (!path.isFunction()) return;
        const holds = loc.end.line >= range.endLine
          && (loc.start.line < range.startLine || (loc.start.line === range.startLine && loc.end.line <= range.endLine));
        if (holds) innermost = path as NodePath<t.Function>;
        else if (loc.start.line === range.startLine && loc.end.line > range.endLine) startsOnLine = true;
      },
    });
  } catch {
    return unknown;
  }
  if (!hasStatement) return unknown;

  /** Steps from the file load to the body of `fn`, or to the top level when `fn` is undefined. */
  const stepsTo = (fn: NodePath<t.Function> | null | undefined, visiting: ReadonlySet<t.Node>): ExecutionStep[] => {
    if (!fn) return [];
    if (visiting.has(fn.node) || visiting.size >= MAX_EXECUTION_STEPS) return [{ kind: 'UNKNOWN' }];
    const next = new Set([...visiting, fn.node]);
    const line = fn.node.loc?.start.line;
    const parent = fn.parentPath;
    const definition = rangeOf(fn.node);
    const entered = definition ? { definition } : {};
    const statementAt = (path: NodePath): { statement?: CodeRange; within?: ExecutionStep['within'] } => {
      const own = statementOf(path);
      const range = rangeOf(own?.node);
      if (!own || !range) return {};
      // The outermost statement around the call inside the same function, or at the top level.
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
    };
    if (fn.isClassMethod() || fn.isObjectMethod() || fn.isClassPrivateMethod()) return [{ kind: 'UNKNOWN', line }];

    // (function () { ... })(), (() => { ... })(), !function () { ... }()
    if (parent?.isCallExpression() && parent.node.callee === fn.node) {
      return [...stepsTo(parent.getFunctionParent(), next), { kind: 'IMMEDIATE_CALL', line: parent.node.loc?.start.line, ...entered }];
    }
    // A function handed to a call: registered there, fired by whatever that call decides.
    if (parent?.isCallExpression() || parent?.isNewExpression()) {
      const symbol = calleeText(parent.node.callee);
      return [...stepsTo(parent.getFunctionParent(), next), { kind: 'CALLBACK_REGISTRATION', ...(symbol ? { symbol } : {}), line: parent.node.loc?.start.line, ...statementAt(parent), ...entered }];
    }

    let name: string | undefined;
    let scopePath: NodePath = fn;
    if (fn.isFunctionDeclaration() && fn.node.id) name = fn.node.id.name;
    else if (parent?.isVariableDeclarator() && parent.node.init === fn.node && t.isIdentifier(parent.node.id)) { name = parent.node.id.name; scopePath = parent; }
    else if (parent?.isAssignmentExpression() && parent.node.right === fn.node) {
      const target = memberPath(parent.node.left);
      const exported = target !== undefined && (target.join('.') === 'module.exports' || target[0] === 'exports' || (target[0] === 'module' && target[1] === 'exports'));
      return [{ kind: exported ? 'EXPORT' : 'UNKNOWN', ...(target ? { symbol: target.join('.') } : {}), line }];
    } else if (parent?.isExportDefaultDeclaration()) return [{ kind: 'EXPORT', symbol: 'default', line }];
    if (name === undefined) return [{ kind: 'UNKNOWN', line }];

    const binding = scopePath.scope.getBinding(name) ?? scopePath.parentPath?.scope.getBinding(name);
    if (!binding) return [{ kind: 'UNKNOWN', symbol: name, line }];
    let best: ExecutionStep[] | undefined;
    let exported = fn.parentPath?.isExportNamedDeclaration() === true || fn.parentPath?.isExportDefaultDeclaration() === true
      || (scopePath.parentPath?.parentPath?.isExportNamedDeclaration() === true);
    const consider = (steps: ExecutionStep[]) => {
      if (!best || POSITION_RANK[positionOf(steps)] < POSITION_RANK[positionOf(best)]) best = steps;
    };
    for (const reference of binding.referencePaths) {
      const user = reference.parentPath;
      if (!user) continue;
      const at = reference.node.loc?.start.line;
      if (user.isCallExpression() && user.node.callee === reference.node) {
        consider([...stepsTo(reference.getFunctionParent(), next), { kind: 'CALL', symbol: name, line: at, ...statementAt(user), ...entered }]);
      } else if ((user.isCallExpression() || user.isNewExpression()) && (user.node.arguments as t.Node[]).includes(reference.node)) {
        const symbol = calleeText(user.node.callee);
        consider([...stepsTo(reference.getFunctionParent(), next), { kind: 'CALLBACK_REGISTRATION', ...(symbol ? { symbol } : {}), line: at, ...statementAt(user), ...entered }]);
      } else if (user.isExportSpecifier() || user.isExportDefaultDeclaration()) {
        exported = true;
      } else {
        // module.exports = name, module.exports = { name }, exports.name = name
        const assignment = reference.findParent((item) => item.isAssignmentExpression());
        const target = assignment?.isAssignmentExpression() ? memberPath(assignment.node.left) : undefined;
        if (target && (target[0] === 'exports' || (target[0] === 'module' && target[1] === 'exports'))) exported = true;
      }
    }
    if (best) return best;
    return [{ kind: exported ? 'EXPORT' : 'UNKNOWN', symbol: name, line }];
  };

  let steps: ExecutionStep[];
  try {
    steps = stepsTo(innermost, new Set());
  } catch {
    return unknown;
  }
  return { position: positionOf(steps), steps, ...(startsOnLine ? { callbackStartsOnLine: true as const } : {}) };
}

/**
 * The complete statement a Finding's lines belong to: the outermost statement
 * that starts on the Finding's first line, else the innermost statement that
 * holds the lines. Undefined when the file does not parse or the lines hold no
 * statement.
 */
export function findingStatement(code: string, range: CodeRange, cache?: ParseCache): CodeRange | undefined {
  const ast = parseModule(code, cache);
  if (!ast || ((ast as { errors?: unknown[] }).errors?.length ?? 0) > 0) return undefined;
  let starting: CodeRange | undefined;
  let holding: CodeRange | undefined;
  try {
    traverse(ast, {
      enter(path) {
        const { loc } = path.node;
        if (!loc) return;
        if (loc.start.line > range.endLine || loc.end.line < range.startLine) { path.skip(); return; }
        if (!path.isStatement() || path.isBlockStatement()) return;
        const statement = rangeOf(statementOf(path)?.node);
        if (!statement) return;
        if (statement.startLine === range.startLine) starting ??= statement;
        if (statement.startLine <= range.startLine && statement.endLine >= range.endLine) holding = statement;
      },
    });
  } catch {
    return undefined;
  }
  return starting ?? holding;
}
