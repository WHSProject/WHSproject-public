import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import type { PackageContextV0_3 } from '../../artifact/agent-analysis-input.contract';
import type { ArtifactResolver } from '../../artifact/artifact.contract';
import { createParseCache, type ParseCache } from '../code-units';
import { buildCallEdges, type IndexedCallEdge, type ValueResolver } from './call-graph';
import { readLifecycleCommand } from './lifecycle-command';
import { createModuleResolver, type ModuleResolver } from './module-resolution';
import { collectProgramFiles } from './program-files';
import {
  PROGRAM_INDEX_LIMITS, fileKey,
  type DataFlowEdge, type ExportRecord, type FileRef, type ModuleEdge, type ProgramFile, type ProgramIndexDiagnostics, type ProgramIndexLimits,
  type ProgramSymbol, type StatementRef, type TriggerRoot,
} from './program-index.contract';
import { WorkLimitError, readFileFacts, type FileFacts } from './program-parse';

export interface ProgramModule extends FileRef { symbolId: string; imports: FileRef[]; importedBy: FileRef[] }

/**
 * One scan's view of the package: every supported source file parsed once, the
 * modules and functions in them, and how they import, call and feed each other.
 * It is built once and shared by every Finding group of the check.
 */
export interface PackageProgramIndex {
  files: ProgramFile[];
  /** Module graph: what each file loads and what loads it. */
  modules: Map<string, ProgramModule>;
  symbols: Map<string, ProgramSymbol>;
  imports: ModuleEdge[];
  exports: ExportRecord[];
  calls: IndexedCallEdge[];
  /** Imports by the file they load. */
  reverseImports: Map<string, ModuleEdge[]>;
  /** Calls, callback hand-overs and module loads by the symbol they reach. */
  reverseCalls: Map<string, IndexedCallEdge[]>;
  /** Value-flow edges found so far; filled as INPUT witnesses are traced. */
  dataFlow: DataFlowEdge[];
  parseFailures: Array<FileRef & { reason: string }>;
  limitations: string[];
  /** Files a lifecycle script runs and files the package names as entry points. */
  roots: Array<TriggerRoot & { symbolId: string }>;
  diagnostics: ProgramIndexDiagnostics;
  limits: ProgramIndexLimits;
  /** Parsed files, shared with the single-file analysis so nothing is parsed twice. */
  parseCache: ParseCache;
  /** Parsed files and resolvers the witness searches work on. */
  internal: { facts: Map<string, FileFacts>; values: ValueResolver; modules: ModuleResolver };
}

export interface ProgramIndexInput {
  resolver: ArtifactResolver;
  packageContext: Pick<PackageContextV0_3, 'lifecycleScripts' | 'entryPoints'>;
  maxFileSizeBytes: number;
  limits?: Partial<Omit<ProgramIndexLimits, 'maxFileSizeBytes'>>;
  /** Files to read and parse first: the files that hold Findings. Lifecycle and entry files are always among the first. */
  priorityPaths?: readonly string[];
  parseCache?: ParseCache;
  signal?: AbortSignal;
}

/** Source text of an indexed file, or undefined when the file is not in the index. */
export function indexedSource(index: PackageProgramIndex, file: FileRef): string | undefined {
  return index.internal.facts.get(fileKey(file))?.code;
}

/**
 * A statement that ends with a function body (an exported function, a callback
 * handed to a call) is cut down to the lines up to where that body starts: the
 * path needs the declaration, not everything the function does.
 */
export function compactStatement(index: PackageProgramIndex, statement: StatementRef): StatementRef {
  const symbols = index.internal.facts.get(fileKey(statement))?.symbols ?? [];
  const held = symbols.find((symbol) => symbol.kind !== 'MODULE' && symbol.header !== undefined
    && symbol.startLine >= statement.startLine && symbol.endLine === statement.endLine && symbol.header.endLine < statement.endLine);
  return held?.header ? { ...statement, endLine: held.header.endLine } : statement;
}

/**
 * Builds the index. A file that cannot be read or parsed, an import that cannot
 * be resolved and any limit that is reached are recorded and the build goes on
 * with what it has; only an aborted scan stops it with an error.
 */
export async function buildPackageProgramIndex(input: ProgramIndexInput): Promise<PackageProgramIndex> {
  const started = Date.now();
  const { resolver, signal } = input;
  const limits: ProgramIndexLimits = { ...PROGRAM_INDEX_LIMITS, ...input.limits, maxFileSizeBytes: input.maxFileSizeBytes };
  const parseCache = input.parseCache ?? createParseCache();
  const artifactIds = resolver.list().map((artifact) => artifact.artifactId);
  // Reading may use half of the time: what is read has to be parsed as well. What matters most is read first, so a
  // limit that stops the build leaves the files of the Findings and of what runs the package.
  const priorityPaths = [
    ...(input.priorityPaths ?? []),
    ...input.packageContext.lifecycleScripts.flatMap((script) => readLifecycleCommand(script.command).files),
    ...input.packageContext.entryPoints.map((entry) => entry.value),
  ];
  const collection = await collectProgramFiles(resolver, artifactIds, limits, { priorityPaths, deadline: started + limits.buildTimeoutMs / 2, signal });
  const appliedLimits = [...collection.appliedLimits];
  const limitations = [...collection.limitations];
  const excludedFiles = [...collection.excluded];
  const limit = (name: string) => { if (!appliedLimits.includes(name)) appliedLimits.push(name); };

  const parseStarted = performance.now();
  const facts = new Map<string, FileFacts>();
  const files: ProgramFile[] = [];
  const parseFailures: PackageProgramIndex['parseFailures'] = [];
  const budget = { nodes: limits.maxAstNodes };
  const deadline = started + limits.buildTimeoutMs;
  let stopped: 'WORK_LIMIT' | 'TIMEOUT' | undefined;
  for (const file of collection.files) {
    signal?.throwIfAborted();
    const ref = { artifactId: file.artifactId, filePath: file.filePath };
    if (stopped === undefined && Date.now() > deadline) stopped = 'TIMEOUT';
    if (stopped !== undefined) { excludedFiles.push({ ...ref, reason: stopped }); continue; }
    try {
      const outcome = readFileFacts(file, budget);
      parseCache.set(file.code, outcome.ast);
      files.push({ ...ref, bytes: file.bytes, lineCount: file.lineCount, parsed: outcome.facts !== undefined });
      if (outcome.facts) facts.set(fileKey(ref), outcome.facts);
      else parseFailures.push({ ...ref, reason: outcome.reason });
    } catch (error) {
      if (!(error instanceof WorkLimitError)) throw error;
      stopped = 'WORK_LIMIT';
      excludedFiles.push({ ...ref, reason: stopped });
    }
  }
  if (stopped !== undefined) limit(stopped);
  if (parseFailures.length > 0) limitations.push('PARSE_FAILURES');
  const astParseMs = performance.now() - parseStarted;

  const graphStarted = performance.now();
  const known = new Set(collection.files.map((file) => fileKey(file)));
  const modules = createModuleResolver(resolver, known, new Set(facts.keys()), limits.maxFileSizeBytes, signal);
  const imports: Array<ModuleEdge & { node: t.Node; path: NodePath }> = [];
  const loads = new Map<t.Node, ModuleEdge>();
  const reexports = new Map<string, ModuleEdge>();
  for (const file of facts.values()) {
    for (const item of file.imports) {
      signal?.throwIfAborted();
      const base = { from: file.ref, inSymbolId: item.inSymbol.id, statement: { ...file.ref, ...item.statement }, kind: item.kind, specifier: item.specifier };
      let edge: ModuleEdge;
      if (item.specifier === null) edge = { ...base, resolution: 'UNRESOLVED', unresolvedReason: 'COMPUTED_SPECIFIER' };
      else {
        const found = await modules.resolve(file.ref, item.specifier, item.kind === 'REQUIRE' ? 'require' : 'import');
        edge = found.resolution === 'RESOLVED' ? { ...base, resolution: 'RESOLVED', to: found.to }
          : found.resolution === 'EXTERNAL' ? { ...base, resolution: 'EXTERNAL' } : { ...base, resolution: 'UNRESOLVED', unresolvedReason: found.reason };
      }
      imports.push({ ...edge, node: item.path.node, path: item.path });
      loads.set(item.path.node, edge);
      if (item.kind === 'REEXPORT' && item.specifier !== null) reexports.set(`${fileKey(file.ref)}\u0000${item.specifier}`, edge);
    }
  }

  const promiseRedefined = [...facts.values()].some((file) => file.redefinesPromise);
  const graph = buildCallEdges({ files: facts, loads, reexports, promiseRedefined }, imports);
  if (graph.failedCalls > 0) limitations.push('CALL_RESOLUTION_FAILED');
  const symbols = new Map<string, ProgramSymbol>();
  for (const file of facts.values()) for (const symbol of file.symbols) symbols.set(symbol.id, symbol);
  const reverseCalls = new Map<string, IndexedCallEdge[]>();
  for (const edge of graph.edges) {
    if (edge.calleeId === undefined) continue;
    reverseCalls.set(edge.calleeId, [...(reverseCalls.get(edge.calleeId) ?? []), edge]);
  }
  const publicImports: ModuleEdge[] = imports.map(({ node: _node, path: _path, ...edge }) => edge);
  const reverseImports = new Map<string, ModuleEdge[]>();
  const moduleGraph = new Map<string, ProgramModule>();
  for (const file of facts.values()) moduleGraph.set(fileKey(file.ref), { ...file.ref, symbolId: file.module.id, imports: [], importedBy: [] });
  for (const edge of publicImports) {
    if (edge.resolution !== 'RESOLVED' || !edge.to) continue;
    const key = fileKey(edge.to);
    reverseImports.set(key, [...(reverseImports.get(key) ?? []), edge]);
    const from = moduleGraph.get(fileKey(edge.from));
    const to = moduleGraph.get(key);
    if (from && !from.imports.some((item) => fileKey(item) === key)) from.imports.push(edge.to);
    if (to && !to.importedBy.some((item) => fileKey(item) === fileKey(edge.from))) to.importedBy.push(edge.from);
  }

  const exports: ExportRecord[] = [];
  for (const file of facts.values()) {
    const record = (name: string, definition: NonNullable<FileFacts['exports']['default']>): ExportRecord => ({
      ...file.ref, name, statement: { ...file.ref, ...definition.statement }, ...(definition.reexport ? { reexportOf: definition.reexport } : {}),
    });
    if (file.exports.default) exports.push(record('default', file.exports.default));
    for (const [name, definition] of file.exports.named) exports.push(record(name, definition));
    for (const star of file.exports.stars) exports.push({ ...file.ref, name: '*', statement: { ...file.ref, ...star.statement }, reexportOf: { specifier: star.specifier, name: '*' } });
  }

  const roots: PackageProgramIndex['roots'] = [];
  const addRoot = async (kind: TriggerRoot['kind'], name: string, path: string) => {
    for (const artifactId of artifactIds) {
      const found = await modules.resolvePath(artifactId, path);
      const file = found ? facts.get(fileKey(found)) : undefined;
      if (!found || !file || roots.some((root) => root.symbolId === file.module.id && root.kind === kind && root.name === name)) continue;
      roots.push({ ...found, kind, name, symbolId: file.module.id });
    }
  };
  let manifest: Record<string, unknown> = {};
  for (const artifactId of artifactIds) {
    const found = await modules.manifest(artifactId, '');
    if (typeof found === 'object' && found !== null) { manifest = found as Record<string, unknown>; break; }
  }
  const scripts = Object.fromEntries(Object.entries(typeof manifest.scripts === 'object' && manifest.scripts !== null ? manifest.scripts : {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const script of input.packageContext.lifecycleScripts) {
    const command = readLifecycleCommand(script.command, scripts);
    if (command.notStatic && !limitations.includes('LIFECYCLE_COMMAND_NOT_STATIC')) limitations.push('LIFECYCLE_COMMAND_NOT_STATIC');
    for (const path of command.files) await addRoot('LIFECYCLE', script.name, path);
  }
  for (const entry of input.packageContext.entryPoints) await addRoot('ENTRY_POINT', entry.type, entry.value);
  if (typeof manifest.module === 'string') await addRoot('ENTRY_POINT', 'MODULE', manifest.module);
  // Without `main` and `exports`, requiring the package loads its index file.
  if (manifest.main === undefined && manifest.exports === undefined && !input.packageContext.entryPoints.some((entry) => entry.type !== 'BIN')) await addRoot('ENTRY_POINT', 'MAIN', 'index');
  const lifecycleNames = new Set<string>(input.packageContext.lifecycleScripts.map((script) => script.name));
  for (const [name, command] of Object.entries(scripts)) {
    if (lifecycleNames.has(name)) continue;
    for (const path of readLifecycleCommand(command, scripts).files) await addRoot('SCRIPT', name, path);
  }

  const unresolvedModuleEdgeCount = publicImports.filter((edge) => edge.resolution === 'UNRESOLVED').length;
  if (unresolvedModuleEdgeCount > 0) limitations.push('UNRESOLVED_MODULE_EDGES');
  const graphBuildMs = performance.now() - graphStarted;
  return {
    files, modules: moduleGraph, symbols, imports: publicImports, exports, calls: graph.edges, reverseImports, reverseCalls, dataFlow: [], parseFailures,
    limitations, roots, limits, parseCache,
    diagnostics: {
      candidateFileCount: collection.candidateFileCount, parsedFileCount: facts.size, parseFailureCount: parseFailures.length, excludedFiles,
      totalSourceBytes: collection.totalSourceBytes, symbolCount: symbols.size, callEdgeCount: graph.edges.length, moduleEdgeCount: publicImports.length,
      unresolvedModuleEdgeCount, appliedLimits, limitations: [...limitations], durationMs: Date.now() - started,
      timing: { ...collection.timing, astParseMs, graphBuildMs },
    },
    internal: { facts, values: graph.resolver, modules },
  };
}
