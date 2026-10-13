import { findingStatement } from '../code-units';
import type { IndexedCallEdge } from './call-graph';
import {
  EVIDENCE_RANK, ROOT_RANK, fileKey, statementKey, isConfirmed, weakestEvidence, type TriggerRoot,
  type EvidenceLevel, type FileRef, type LineRange, type ProgramSymbol, type StatementRef, type TriggerWitness, type TriggerWitnessStep,
} from './program-index.contract';
import { compactStatement, type PackageProgramIndex } from './program-index';

/**
 * The function a Finding's lines belong to, or the module when they are at the
 * top level. A function that starts on the Finding's first line and runs past
 * its last line is taken to start there, not to hold it (the same reading as
 * the single-file path analysis).
 */
export function symbolHolding(index: PackageProgramIndex, file: FileRef, range: LineRange): ProgramSymbol | undefined {
  const facts = index.internal.facts.get(fileKey(file));
  if (!facts) return undefined;
  let innermost: ProgramSymbol = facts.module;
  for (const symbol of facts.symbols) {
    if (symbol.kind === 'MODULE') continue;
    const holds = symbol.endLine >= range.endLine
      && (symbol.startLine < range.startLine || (symbol.startLine === range.startLine && symbol.endLine <= range.endLine));
    // Symbols are in source order, so a later one that holds the lines is nested in the earlier one.
    if (holds) innermost = symbol;
  }
  return innermost;
}



const exportedByIndex = new WeakMap<PackageProgramIndex, Map<string, StatementRef[]>>();
/**
 * Functions the files of the package export (a function itself, the methods of an exported class, the functions of an
 * exported object), each with the statements that show it is exported. A statement that holds the whole class or
 * object is cut down to its lines up to the opening brace.
 */
function exportedSymbols(index: PackageProgramIndex): Map<string, StatementRef[]> {
  const known = exportedByIndex.get(index);
  if (known) return known;
  const found = new Map<string, StatementRef[]>();
  const keep = (id: string, statements: StatementRef[]) => {
    const current = found.get(id);
    if (!current || statements.length < current.length) found.set(id, statements);
  };
  for (const file of index.internal.facts.values()) {
    for (const name of ['default', ...file.exports.named.keys()]) {
      try {
        const { value, links } = index.internal.values.exported(file, name);
        if (value.kind === 'FUNCTION') keep(value.symbol.id, links.map((link) => compactStatement(index, link)));
        if (value.kind !== 'CLASS' && value.kind !== 'OBJECT') continue;
        const whole = value.path.node.loc;
        const open = value.kind === 'CLASS' ? value.path.node.body.loc?.start.line : whole?.start.line;
        if (!whole || open === undefined) continue;
        const holder = value.file.ref;
        const holds = (link: StatementRef) => fileKey(link) === fileKey(holder) && link.startLine <= whole.start.line && link.endLine >= whole.end.line;
        const statements = links.map((link) => (holds(link) ? { ...link, endLine: open } : link));
        if (value.kind === 'CLASS' && !links.some(holds)) statements.push({ ...holder, startLine: whole.start.line, endLine: open });
        const members = value.kind === 'CLASS' ? value.path.get('body').get('body') : value.path.get('properties');
        for (const member of members) {
          const node = member.isObjectProperty() || member.isClassProperty() ? member.node.value : member.node;
          const symbol = node ? value.file.symbolOfFunction.get(node) : undefined;
          if (symbol) keep(symbol.id, statements);
        }
      } catch {
        // An export that cannot be resolved names nothing.
      }
    }
  }
  exportedByIndex.set(index, found);
  return found;
}

/** A line this long is a bundle or minified code: adding it would cost more than the declaration it shows is worth. */
const MAX_EXPORT_LINE_LENGTH = 300;

/** A path being followed from the Finding outwards: the edges taken so far, nearest the Finding first. */
interface Partial { symbolId: string; edges: IndexedCallEdge[]; probable: number; deferred: number; visited: Set<string> }
type StopReason = 'UNRESOLVED_EDGE' | 'DEPTH_LIMIT' | 'NO_CALLER_FOUND' | 'FILE_NOT_LOADED_FROM_LIFECYCLE_OR_ENTRY';
interface Stop { path: Partial; reason: StopReason; steps?: TriggerWitnessStep[] }
const STOP_ORDER: Record<StopReason, number> = { UNRESOLVED_EDGE: 0, FILE_NOT_LOADED_FROM_LIFECYCLE_OR_ENTRY: 1, DEPTH_LIMIT: 2, NO_CALLER_FOUND: 3 };

/**
 * Follows a Finding back to what runs the package: the function that holds it,
 * the calls that reach that function, the imports that load each file, up to a
 * file a lifecycle script runs or the package names as an entry point.
 *
 * A path made of confirmed steps is followed for `maxCallDepth` steps, a path
 * that holds a probable step for `maxProbableDepth`. An unresolved step (a
 * timer, an outside event, a callback that is only registered, a dynamic
 * callee) is never followed: the path ends there and is reported with that step
 * as its last one. No symbol is entered twice on one path. Among the paths that
 * reach a root, the one with the largest share of confirmed steps wins, then
 * the shortest, so a confirmed path is never given up for a shorter probable one.
 */
export function findTriggerWitness(index: PackageProgramIndex, file: FileRef, range: LineRange): TriggerWitness {
  return findTriggerWitnesses(index, file, range)[0]!;
}

/** The best path first, then the other paths that reach a root (another root, or the same one with other steps), at most `maxWitnessPaths`. */
export function findTriggerWitnesses(index: PackageProgramIndex, file: FileRef, range: LineRange): TriggerWitness[] {
  const facts = index.internal.facts.get(fileKey(file));
  const located = facts ? findingStatement(facts.code, range, index.parseCache) : undefined;
  const finding: StatementRef = { ...file, startLine: located?.startLine ?? range.startLine, endLine: located?.endLine ?? range.endLine };
  const target = symbolHolding(index, file, range);
  if (!facts || !target) {
    return [{
      status: 'INCOMPLETE', finding, steps: [], evidence: 'UNRESOLVED', asyncBoundary: false, incomplete: { file, reason: 'FILE_NOT_INDEXED' }, statements: [finding],
      limitations: ['FILE_NOT_INDEXED'], exploredDepth: 0, probableEdgeCount: 0, conditional: { eligible: false, reason: 'NO_ROOT' },
    }];
  }
  const limitations: string[] = [];
  const limitation = (name: string) => { if (!limitations.includes(name)) limitations.push(name); };
  // A file that a lifecycle script runs and the package also names as an entry point counts as the lifecycle root.
  const rootIds = new Map([...index.roots].reverse().map((root) => [root.symbolId, root]));
  const { limits } = index;
  const deadline = Date.now() + limits.witnessSearchTimeoutMs;

  /** Edges that reach `symbol`. A restored file is also loaded by whatever loads the original it was restored from. */
  const incoming = (symbol: ProgramSymbol): IndexedCallEdge[] => {
    const direct = index.reverseCalls.get(symbol.id) ?? [];
    if (symbol.kind !== 'MODULE') return direct;
    const counterparts = index.internal.modules.lookupArtifacts(symbol.artifactId).slice(1)
      .map((artifactId) => index.internal.facts.get(fileKey({ artifactId, filePath: symbol.filePath }))?.module.id)
      .filter((id): id is string => id !== undefined);
    return [...direct, ...counterparts.flatMap((id) => index.reverseCalls.get(id) ?? [])];
  };
  const rootOf = (symbol: ProgramSymbol) => rootIds.get(symbol.id)
    ?? (symbol.kind === 'MODULE' ? index.roots.find((root) => root.filePath === symbol.filePath && index.internal.modules.lookupArtifacts(symbol.artifactId).includes(root.artifactId)) : undefined);

  const stepsOf = (edges: readonly IndexedCallEdge[]): TriggerWitnessStep[] => [...edges].reverse().map((edge) => {
    const caller = index.symbols.get(edge.callerId);
    const callee = edge.calleeId === undefined ? undefined : index.symbols.get(edge.calleeId);
    return {
      kind: edge.kind, site: edge.site, links: edge.links, evidence: edge.evidence, asyncBoundary: edge.asyncBoundary,
      ...(caller?.name === undefined ? {} : { callerSymbol: caller.name }),
      ...(callee?.name ?? edge.calleeName) === undefined ? {} : { calleeSymbol: callee?.name ?? edge.calleeName },
      ...(edge.callbackKind === undefined ? {} : { callbackKind: edge.callbackKind }),
      ...(edge.within === undefined ? {} : { within: edge.within }),
      ...(edge.unresolvedReason === undefined ? {} : { unresolvedReason: edge.unresolvedReason }),
      ...(edge.basis === undefined ? {} : { basis: edge.basis }),
      ...(edge.registeredAt === undefined ? {} : { registeredAt: edge.registeredAt }),
      ...(edge.executedAt === undefined ? {} : { executedAt: edge.executedAt }),
    };
  });
  /** What only the whole path can tell: whether a run-directly branch holds, and whether an asynchronous step survives its callers. */
  const settle = (edges: readonly IndexedCallEdge[], root: TriggerRoot | undefined): TriggerWitnessStep[] => {
    const steps = stepsOf(edges);
    const ordered = [...edges].reverse();
    const downgrade = (step: TriggerWitnessStep, evidence: EvidenceLevel, reason: string) => {
      if (EVIDENCE_RANK[evidence] <= EVIDENCE_RANK[step.evidence]) return;
      step.evidence = evidence;
      step.unresolvedReason = reason;
      step.basis = reason;
    };
    for (const [position, step] of steps.entries()) {
      // `require.main === module` holds only for the file that is itself run as a script.
      if (step.within?.kind === 'RUN_DIRECTLY' && root && (step.site.filePath !== root.filePath || root.kind === 'EXPORTED_API' || (root.kind === 'ENTRY_POINT' && root.name !== 'BIN'))) {
        downgrade(step, 'UNRESOLVED', 'RUN_DIRECTLY_CONDITION_NOT_MET');
      }
      // Something that completes after the current run is lost when an earlier caller ends the process right after its call.
      if (step.evidence !== 'CONFIRMED_ASYNC') continue;
      for (let earlier = 0; earlier < position; earlier += 1) {
        const callerEdge = ordered[earlier]!;
        const caller = index.symbols.get(callerEdge.callerId);
        if (caller?.terminatorLines.some((line) => line > callerEdge.site.endLine)) downgrade(step, 'PROBABLE', 'TERMINATION_AFTER_REGISTRATION');
      }
    }
    return steps;
  };

  // Paths with fewer probable steps are followed first, shorter ones before longer ones, so the first root reached
  // by confirmed steps alone is the shortest such path.
  const queue: Partial[] = [{ symbolId: target.id, edges: [], probable: 0, deferred: 0, visited: new Set([target.id]) }];
  const entered = new Set<string>([`${target.id}\u00000\u00000`]);
  const candidates: Array<{ path: Partial; root: TriggerRoot; steps: TriggerWitnessStep[] }> = [];
  // Where nothing in the package leads further: the path starts at what the package exports, or at code nothing refers to.
  const loose: typeof candidates = [];
  const startAt = (path: Partial, symbol: ProgramSymbol) => {
    const root: TriggerRoot = {
      artifactId: symbol.artifactId, filePath: symbol.filePath, name: symbol.name ?? symbol.filePath,
      kind: symbol.kind !== 'MODULE' && exportedSymbols(index).has(symbol.id) ? 'EXPORTED_API' : 'UNREFERENCED',
    };
    const steps = settle(path.edges, root);
    if (steps.some((step) => step.evidence === 'UNRESOLVED')) stops.push({ path, reason: 'UNRESOLVED_EDGE', steps });
    else if (loose.length < limits.maxWitnessPaths) loose.push({ path, root, steps });
  };
  const stops: Stop[] = [];
  let exploredDepth = 0;
  let expanded = 0;
  while (queue.length > 0 && candidates.length < limits.maxWitnessPaths) {
    if (Date.now() > deadline) { limitation('SEARCH_TIMEOUT'); break; }
    if (expanded >= limits.maxVisitedSymbols) { limitation('VISITED_SYMBOL_LIMIT'); break; }
    let best = 0;
    for (let position = 1; position < queue.length; position += 1) {
      const [left, right] = [queue[position]!, queue[best]!];
      // Fewer probable steps first, then fewer steps that only run later, then the shorter path.
      if ((left.probable - right.probable || left.deferred - right.deferred || left.edges.length - right.edges.length) < 0) best = position;
    }
    const [path] = queue.splice(best, 1);
    expanded += 1;
    exploredDepth = Math.max(exploredDepth, path!.edges.length);
    const current = index.symbols.get(path!.symbolId)!;
    const root = rootOf(current);
    if (root) {
      const steps = settle(path!.edges, root);
      // A step that the whole path shows not to hold ends the path like any other unresolved step.
      if (steps.some((step) => step.evidence === 'UNRESOLVED')) stops.push({ path: path!, reason: 'UNRESOLVED_EDGE', steps });
      else candidates.push({ path: path!, root, steps });
      continue;
    }
    const edges = incoming(current).filter((edge) => index.symbols.has(edge.callerId));
    // Callers that are all on the path already (functions that only call each other) lead nowhere new: the path starts here.
    if (edges.every((edge) => path!.visited.has(edge.callerId))) { startAt(path!, current); continue; }
    for (const edge of edges) {
      if (path!.visited.has(edge.callerId)) continue;
      const next: Partial = { symbolId: edge.callerId, edges: [...path!.edges, edge],
        probable: path!.probable + (edge.evidence === 'PROBABLE' ? 1 : 0), deferred: path!.deferred + (edge.evidence === 'CONFIRMED_ASYNC' ? 1 : 0),
          visited: new Set([...path!.visited, edge.callerId]) };
      if (edge.evidence === 'UNRESOLVED') { stops.push({ path: next, reason: 'UNRESOLVED_EDGE' }); continue; }
      if (next.edges.length > (next.probable > 0 ? limits.maxProbableDepth : limits.maxCallDepth)) { limitation('DEPTH_LIMIT'); startAt(path!, current); continue; }
      const key = `${edge.callerId}\u0000${Math.min(next.probable, 2)}\u0000${Math.min(next.deferred, 1)}`;
      if (entered.has(key)) continue;
      entered.add(key);
      queue.push(next);
    }
  }

  const ratio = (steps: readonly TriggerWitnessStep[]): number => (steps.length === 0 ? 1 : steps.filter((step) => isConfirmed(step.evidence)).length / steps.length);
  const build = (steps: TriggerWitnessStep[], chosen: (typeof candidates)[number] | undefined, stop: Stop | undefined): TriggerWitness => {
    const own = [...limitations];
    const probableEdgeCount = steps.filter((step) => step.evidence === 'PROBABLE').length;
    if (!chosen && stop?.reason === 'UNRESOLVED_EDGE' && !own.includes('UNRESOLVED_EDGE')) own.push('UNRESOLVED_EDGE');
    const evidence = steps.length === 0 ? 'CONFIRMED' as const : weakestEvidence(steps.map((step) => step.evidence));
    const statements: StatementRef[] = [];
    const seen = new Set<string>();
    const declared = chosen?.root.kind === 'EXPORTED_API' ? exportedSymbols(index).get(chosen.path.symbolId) ?? [] : [];
    const within = (item: StatementRef) => fileKey(item) === fileKey(finding) && item.startLine >= finding.startLine && item.endLine <= finding.endLine;
    const tooLong = (item: StatementRef) => !within(item) && (index.internal.facts.get(fileKey(item))?.code.split(/\r?\n/u).slice(item.startLine - 1, item.endLine) ?? [])
      .some((line) => line.length > MAX_EXPORT_LINE_LENGTH);
    if (declared.some(tooLong)) own.push('EXPORT_STATEMENT_TOO_LONG');
    for (const item of [...declared.filter((entry) => !tooLong(entry)), ...steps.flatMap((step) => [step.site, ...step.links]).map((item) => compactStatement(index, item)), finding]) {
      if (seen.has(statementKey(item))) continue;
      seen.add(statementKey(item));
      statements.push(item);
    }
    const base = { finding, steps, asyncBoundary: steps.some((step) => step.asyncBoundary), statements, limitations: own, exploredDepth, probableEdgeCount };
    if (chosen) {
      return {
        ...base, evidence, status: 'CONFIRMED', conditional: { eligible: false, reason: 'NOT_NEEDED' },
        root: { artifactId: chosen.root.artifactId, filePath: chosen.root.filePath, kind: chosen.root.kind, name: chosen.root.name },
      };
    }
    const last = index.symbols.get(stop?.path.symbolId ?? target.id) ?? target;
    return {
      ...base, status: 'INCOMPLETE', evidence: steps.length === 0 ? 'UNRESOLVED' : evidence, conditional: { eligible: false, reason: 'NO_ROOT' },
      incomplete: {
        file: { artifactId: last.artifactId, filePath: last.filePath }, ...(last.name === undefined ? {} : { symbol: last.name }),
        reason: stop?.reason ?? own[0] ?? 'NO_CALLER_FOUND',
      },
    };
  };
  const plain = (steps: readonly TriggerWitnessStep[]): number => (steps.length === 0 ? 1 : steps.filter((step) => step.evidence === 'CONFIRMED').length / steps.length);
  const ranked = [...candidates, ...loose]
    .sort((left, right) => ROOT_RANK[left.root.kind] - ROOT_RANK[right.root.kind] || ratio(right.steps) - ratio(left.steps)
      || plain(right.steps) - plain(left.steps) || left.steps.length - right.steps.length)
    .slice(0, limits.maxWitnessPaths);
  if (ranked.length === 0) {
    const stop = [...stops].sort((left, right) => (
      left.path.probable - right.path.probable || STOP_ORDER[left.reason] - STOP_ORDER[right.reason] || left.path.edges.length - right.path.edges.length
    ))[0];
    return [build(stop ? stop.steps ?? settle(stop.path.edges, undefined) : [], undefined, stop)];
  }
  const distinct = new Set<string>();
  return ranked.map((candidate) => build(candidate.steps, candidate, undefined)).filter((witness) => {
    const key = witness.statements.map(statementKey).join('|');
    return distinct.has(key) ? false : (distinct.add(key), true);
  });
}
