import { posix } from 'node:path';
import type { PackageContextV0_3 } from '../artifact/agent-analysis-input.contract';
import type { AgentCodeSlice, ArtifactResolver } from '../artifact/artifact.contract';
import { ArtifactReadError, readArtifactSource } from '../artifact/code-slice.factory';
import {
  type ParseCache,
  analyzeFileLinks,
  createParseCache,
  importedCalls,
  relativeImportsReachedBy,
  definitionIsSelfContained,
  entryUnits,
  exportUnits,
  inputValueSource,
  trimmedFileRange,
  type CalledFunction,
  type ImportedCall,
  type CodeRange,
  type CodeUnit,
  type FileLinks,
  type ImportRef,
} from './code-units';
import {
  CONTEXT_CHECK_LIMITS,
  isLifecycleManifest,
  type ContextCode,
  type ContextState,
  type ExpansionCandidate,
  type ExpansionKind,
  type ExplorationClass,
  type FindingGroup,
} from './context-check.contract';

export { analyzeFileLinks } from './code-units';

/**
 * Which directly linked code can make a context visible. Order is the candidate
 * priority within one context, depth and state. For a LIFECYCLE group, ACTION
 * also takes the files the lifecycle scripts run, between local functions and
 * imports, because that is where the installed behavior lives.
 */
export const EXPANSION_KINDS: Record<ContextCode, readonly ExpansionKind[]> = {
  TRIGGER: ['LIFECYCLE_ENTRY'],
  INPUT: ['SAME_FILE_DEFINITION', 'STATIC_IMPORT'],
  ACTION: ['LOCAL_FUNCTION', 'STATIC_IMPORT'],
  TARGET: ['SAME_FILE_DEFINITION', 'STATIC_IMPORT'],
  LINK: ['SAME_FILE_DEFINITION', 'LOCAL_FUNCTION', 'STATIC_IMPORT'],
};
const LIFECYCLE_ACTION_KINDS: readonly ExpansionKind[] = ['LOCAL_FUNCTION', 'LIFECYCLE_ENTRY', 'STATIC_IMPORT'];

export interface UnresolvedContext {
  group: FindingGroup;
  context: ContextCode;
  state: Exclude<ContextState, 'VISIBLE'>;
  /** How far to explore; absent means it follows `state`. */
  exploration?: ExplorationClass;
  /** The model's original answer, copied onto every candidate for the trace. */
  answer?: { score: number; confidence: number };
}

export interface ExpansionCandidateInput {
  unresolved: readonly UnresolvedContext[];
  slices: readonly AgentCodeSlice[];
  resolver: ArtifactResolver;
  packageContext: Pick<PackageContextV0_3, 'lifecycleScripts' | 'entryPoints'>;
  maxFileSizeBytes: number;
  /** Parsed files of the whole-package index, so a file it already read is not parsed again. */
  parseCache?: ParseCache;
  signal?: AbortSignal;
}

/**
 * Statements of one file that follow each other with no line between them,
 * as blocks; blocks keep the order in which their first statement was given.
 * A statement given twice is taken once.
 */
export function contiguousBlocks<T extends WitnessStatement>(statements: readonly T[]): T[][] {
  const byFile = new Map<string, Array<{ item: T; order: number }>>();
  for (const [order, item] of statements.entries()) {
    const key = fileKey(item.artifactId, item.filePath);
    const known = byFile.get(key) ?? [];
    if (!known.some((other) => other.item.startLine === item.startLine && other.item.endLine === item.endLine)) known.push({ item, order });
    byFile.set(key, known);
  }
  const blocks: Array<{ order: number; end: number; items: T[] }> = [];
  for (const entries of byFile.values()) {
    let block: (typeof blocks)[number] | undefined;
    for (const { item, order } of [...entries].sort((left, right) => left.item.startLine - right.item.startLine || left.item.endLine - right.item.endLine)) {
      if (block && item.startLine <= block.end + 1) {
        block.items.push(item);
        block.end = Math.max(block.end, item.endLine);
        block.order = Math.min(block.order, order);
      } else {
        block = { order, end: item.endLine, items: [item] };
        blocks.push(block);
      }
    }
  }
  return blocks.sort((left, right) => left.order - right.order).map((block) => block.items);
}

export interface WitnessStatement { artifactId: string; filePath: string; startLine: number; endLine: number; symbol?: string }
interface SourceFile { artifactId: string; filePath: string; lines: string[] }

const RESOLVE_SUFFIXES = ['', '.js', '.cjs', '.mjs', '/index.js'] as const;

/** Script files a lifecycle command names directly, e.g. `node install.js` or `node ./scripts/setup.js && ...`. */
export function lifecycleScriptFiles(command: string): string[] {
  return command.split(/[\s;&|()]+/u)
    .map((token) => token.replace(/^["']|["']$/gu, ''))
    .filter((token) => /^(?:\.{1,2}\/)?[\w@./-]+\.[cm]?js$/u.test(token));
}

/** Entry point types (`MAIN`, ...) whose value names `filePath` itself, with or without its extension or `/index.js`. */
export function entryPointsAt(packageContext: Pick<PackageContextV0_3, 'entryPoints'>, filePath: string): string[] {
  return packageContext.entryPoints
    .filter((entry) => {
      const base = posix.normalize(entry.value).replace(/\/+$/u, '');
      return RESOLVE_SUFFIXES.some((suffix) => `${base}${suffix}` === filePath);
    })
    .map((entry) => entry.type);
}

/** Names of the lifecycle scripts whose command runs `filePath` itself (`postinstall: node install.js`). */
export function lifecycleScriptsRunning(packageContext: Pick<PackageContextV0_3, 'lifecycleScripts'>, filePath: string): string[] {
  return packageContext.lifecycleScripts
    .filter((script) => lifecycleScriptFiles(script.command).some((path) => posix.normalize(path) === filePath))
    .map((script) => script.name);
}

/**
 * Contexts that take a general second hop, only when the model rated them
 * MISSING. A MISSING INPUT takes a narrower one: the definition of the function
 * its value comes from (`inputSecondHop`).
 */
export const SECOND_HOP_CONTEXTS: readonly ContextCode[] = ['LINK', 'ACTION'];

export const candidateKey = (candidate: Pick<ExpansionCandidate, 'artifactId' | 'filePath' | 'startLine' | 'endLine' | 'symbol'>): string => (
  [candidate.artifactId, candidate.filePath, candidate.startLine, candidate.endLine, candidate.symbol ?? ''].join(':')
);
const fileKey = (artifactId: string, filePath: string): string => `${artifactId}:${filePath}`;

function spanOf(units: readonly CodeRange[], fallback: CodeRange): CodeRange {
  if (units.length === 0) return fallback;
  return { startLine: Math.min(...units.map((unit) => unit.startLine)), endLine: Math.max(...units.map((unit) => unit.endLine)) };
}

/**
 * Candidates for every unresolved context: MISSING before PARTIAL, then first hop
 * before second hop, then group, context and kind order. A MISSING LINK or ACTION
 * context takes one more hop from the statements its first-hop candidates offer.
 *
 * Every candidate is made of complete statements (`units`) tied to what the
 * previous step actually referenced: the declaration of a used variable or
 * function, the export a used import names, or what a lifecycle script or entry
 * point runs at load time. Only when a file does not parse, or an import's name
 * cannot be found, is a limited fallback offered: the module's export statements,
 * else the file's first lines without leading and trailing comments.
 * Ranges are not yet checked against the supplied slices or budgeted;
 * `validateExpansionCandidates` does that.
 */
export async function generateExpansionCandidates(input: ExpansionCandidateInput): Promise<ExpansionCandidate[]> {
  const sources = new Map<string, SourceFile | undefined>();
  const linksByKey = new Map<string, FileLinks | undefined>();
  const maxLines = CONTEXT_CHECK_LIMITS.maxLinesPerCandidate;
  const parsed = input.parseCache ?? createParseCache();

  const readSource = async (artifactId: string, filePath: string): Promise<SourceFile | undefined> => {
    const key = fileKey(artifactId, filePath);
    if (sources.has(key)) return sources.get(key);
    let file: SourceFile | undefined;
    try {
      const source = await readArtifactSource(input.resolver, artifactId, filePath, input.maxFileSizeBytes, input.signal);
      file = source.lineCount > 0 ? { artifactId, filePath: source.filePath, lines: source.lines.slice(0, source.lineCount) } : undefined;
    } catch (error) {
      if (!(error instanceof ArtifactReadError)) throw error;
    }
    sources.set(key, file);
    return file;
  };
  /** The group's own artifact first, then the ORIGINAL it was restored from (a restored artifact holds restored files only). */
  const lookupArtifacts = (artifactId: string): string[] => {
    const original = input.resolver.describe(artifactId)?.derivedFromArtifactId;
    return original === undefined || original === artifactId ? [artifactId] : [artifactId, original];
  };
  const resolveFile = async (artifactId: string, path: string): Promise<SourceFile | undefined> => {
    const base = posix.normalize(path).replace(/\/+$/u, '');
    if (base === '' || base === '.' || base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return undefined;
    for (const candidateArtifact of lookupArtifacts(artifactId)) {
      for (const suffix of RESOLVE_SUFFIXES) {
        const file = await readSource(candidateArtifact, `${base}${suffix}`);
        if (file) return file;
      }
    }
    return undefined;
  };
  /** Links of `covered` in one file; package.json and unreadable files have none. */
  const linksOf = async (artifactId: string, filePath: string, covered: readonly CodeRange[]): Promise<FileLinks | undefined> => {
    const key = `${fileKey(artifactId, filePath)}:${covered.map((range) => `${range.startLine}-${range.endLine}`).join(',')}`;
    if (linksByKey.has(key)) return linksByKey.get(key);
    let links: FileLinks | undefined;
    if (!isLifecycleManifest(filePath) && covered.length > 0) {
      const source = await readSource(artifactId, filePath);
      links = source ? analyzeFileLinks(source.lines.join('\n'), covered, parsed) : undefined;
    }
    linksByKey.set(key, links);
    return links;
  };
  const groupLinks = (group: FindingGroup) => linksOf(group.artifactId, group.filePath, input.slices
    .filter((slice) => slice.artifactId === group.artifactId && slice.filePath === group.filePath)
    .map((slice) => ({ startLine: slice.startLine, endLine: slice.endLine })));

  /** The file's first lines without comment-only edges, as one unaligned unit. */
  const fileFallback = (file: SourceFile) => {
    const range = trimmedFileRange(file.lines, maxLines);
    return { units: range ? [range] : [], statementAligned: false, span: range ?? { startLine: 1, endLine: Math.min(file.lines.length, maxLines) } };
  };
  /** What a used import offers: the named export's statements, else the export statements, else the file fallback. */
  const importOffer = async (file: SourceFile, ref: ImportRef) => {
    const lookup = exportUnits(file.lines.join('\n'), ref.symbol, parsed);
    if (lookup?.matched) return { units: lookup.units, statementAligned: true, symbol: ref.symbol ?? undefined };
    if (lookup && lookup.units.length > 0) return { units: lookup.units, statementAligned: true, symbol: undefined };
    return { ...fileFallback(file), symbol: undefined };
  };
  /** What a lifecycle script or entry point runs; the file fallback when it does not parse. */
  const entryOffer = (file: SourceFile) => {
    const units = entryUnits(file.lines.join('\n'), parsed);
    return units === undefined ? fileFallback(file) : { units, statementAligned: true, span: undefined };
  };

  /** Whether `file` is the group's own file, in its artifact or in the ORIGINAL it was restored from. */
  const isGroupFile = (group: FindingGroup, file: SourceFile): boolean => (
    file.filePath === group.filePath && lookupArtifacts(group.artifactId).includes(file.artifactId)
  );
  const codeOf = (file: SourceFile): string => file.lines.join('\n');

  const importRefs = (links: FileLinks | undefined): ImportRef[] => {
    if (!links) return [];
    return links.parsed ? links.usedImports : links.imports.map((specifier) => ({ specifier, symbol: null }));
  };

  type Base = Pick<ExpansionCandidate, 'groupId' | 'context' | 'state' | 'depth'>;
  const unitCandidate = (base: Base, kind: ExpansionKind, artifactId: string, filePath: string, unit: CodeUnit): ExpansionCandidate => ({
    ...base, kind, artifactId, filePath, startLine: unit.startLine, endLine: unit.endLine, units: [unit], statementAligned: true,
    ...(unit.symbol === undefined ? {} : { symbol: unit.symbol }),
  });
  const offerCandidate = (
    base: Base, kind: ExpansionKind, file: SourceFile,
    offer: { units: CodeUnit[]; statementAligned: boolean; symbol?: string; span?: CodeRange },
  ): ExpansionCandidate => {
    const span = spanOf(offer.units, offer.span ?? { startLine: 1, endLine: Math.min(file.lines.length, maxLines) });
    return {
      ...base, kind, artifactId: file.artifactId, filePath: file.filePath, ...span, units: offer.units, statementAligned: offer.statementAligned,
      ...(offer.symbol === undefined ? {} : { symbol: offer.symbol }),
    };
  };

  const importCandidates = async (base: Base, artifactId: string, filePath: string, refs: readonly ImportRef[], skip: (file: SourceFile, ref: ImportRef) => boolean) => {
    const found: ExpansionCandidate[] = [];
    for (const ref of refs) {
      const file = await resolveFile(artifactId, posix.join(posix.dirname(filePath), ref.specifier));
      if (!file || skip(file, ref)) continue;
      found.push(offerCandidate(base, 'STATIC_IMPORT', file, await importOffer(file, ref)));
    }
    return found;
  };
  const entryCandidates = async (base: Base, group: FindingGroup, lifecycleOnly: boolean) => {
    const lifecyclePaths = input.packageContext.lifecycleScripts.flatMap((script) => lifecycleScriptFiles(script.command));
    const entryPaths = lifecycleOnly ? [] : input.packageContext.entryPoints.map((entry) => entry.value);
    const found: ExpansionCandidate[] = [];
    const seen = new Set<string>();
    for (const [path, fromLifecycle] of [...lifecyclePaths.map((item) => [item, true] as const), ...entryPaths.map((item) => [item, false] as const)]) {
      const file = await resolveFile(group.artifactId, path);
      if (!file || seen.has(fileKey(file.artifactId, file.filePath))) continue;
      seen.add(fileKey(file.artifactId, file.filePath));
      const candidate = offerCandidate(base, 'LIFECYCLE_ENTRY', file, entryOffer(file));
      // A lifecycle command or entry point that is the group's own file already shows who runs this code and when;
      // the file's own statements say what it does (ACTION, LINK), not what triggers it.
      if (base.context === 'TRIGGER' && isGroupFile(group, file)) {
        found.push({ ...candidate, exclusion: fromLifecycle ? 'SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE' : 'SELF_ENTRY_FILE_NOT_TRIGGER_EVIDENCE' });
      } else found.push(candidate);
    }
    return found;
  };

  /** Function an INPUT value statement calls, per first-hop candidate; filled while annotating. */
  const calledFunctions = new Map<ExpansionCandidate, CalledFunction>();
  /**
   * Marks what each INPUT candidate shows about the value's origin. A value
   * statement that calls one statically identified user function needs that
   * function's definition; an import is conclusive only when it names an export
   * whose definition relies on nothing else that is not shown.
   */
  const annotateInput = async (candidate: ExpansionCandidate): Promise<void> => {
    const file = await readSource(candidate.artifactId, candidate.filePath);
    if (!file) { candidate.inputSource = 'UNRESOLVED'; return; }
    if (candidate.kind === 'SAME_FILE_DEFINITION') {
      const value = inputValueSource(codeOf(file), candidate.units[0]!, parsed);
      candidate.inputSource = value.source;
      if (value.source === 'CALL') calledFunctions.set(candidate, value.target);
      return;
    }
    candidate.inputSource = candidate.symbol !== undefined && definitionIsSelfContained(codeOf(file), candidate.units, parsed) ? 'DIRECT' : 'UNRESOLVED';
  };

  /** The statement among `imports` that reaches the group's file, resolved from `file`. */
  const groupFileImport = async (group: FindingGroup, file: SourceFile, imports: readonly { unit: CodeRange; specifier: string }[]) => {
    for (const item of imports) {
      const target = await resolveFile(file.artifactId, posix.join(posix.dirname(file.filePath), item.specifier));
      if (target && isGroupFile(group, target)) return item.unit;
    }
    return undefined;
  };
  /** Imported functions a TRIGGER candidate calls without reaching the group's file itself; filled while annotating. */
  const calledTriggers = new Map<ExpansionCandidate, ImportedCall[]>();
  /**
   * Marks whether a lifecycle or entry candidate shows a path to the group's
   * file: a statement among its units that requires or imports that file. Its
   * calls to imported functions are kept for the narrow second hop.
   */
  const annotateTrigger = async (group: FindingGroup, candidate: ExpansionCandidate): Promise<void> => {
    candidate.triggerSource = 'UNLINKED';
    if (candidate.exclusion || !candidate.statementAligned) return;
    const file = await readSource(candidate.artifactId, candidate.filePath);
    if (!file) return;
    const link = await groupFileImport(group, file, relativeImportsReachedBy(codeOf(file), candidate.units, parsed) ?? []);
    if (link) {
      candidate.triggerSource = 'DIRECT';
      candidate.triggerUnit = link;
      // A top-level side-effect `import` is not one of the units the file runs; the link must be shown too.
      if (!candidate.units.some((unit) => unit.startLine === link.startLine && unit.endLine === link.endLine)) {
        candidate.units = [...candidate.units, link].sort((left, right) => left.startLine - right.startLine);
        Object.assign(candidate, spanOf(candidate.units, candidate));
      }
      return;
    }
    const calls = importedCalls(codeOf(file), candidate.units.filter((unit) => unit.executable === true), parsed);
    if (calls.length > 0) calledTriggers.set(candidate, calls);
  };

  const firstHop = async (item: UnresolvedContext): Promise<ExpansionCandidate[]> => {
    const { group, context, state } = item;
    const base: Base = { groupId: group.groupId, context, state, depth: 1 };
    const lifecycleAction = context === 'ACTION' && group.behavior === 'LIFECYCLE';
    const kinds = lifecycleAction ? LIFECYCLE_ACTION_KINDS : EXPANSION_KINDS[context];
    const found: ExpansionCandidate[] = [];
    const ownFile = fileKey(group.artifactId, group.filePath);
    for (const kind of kinds) {
      if (kind === 'SAME_FILE_DEFINITION' || kind === 'LOCAL_FUNCTION') {
        const links = await groupLinks(group);
        for (const unit of (kind === 'SAME_FILE_DEFINITION' ? links?.definitions : links?.functions) ?? []) {
          found.push(unitCandidate(base, kind, group.artifactId, group.filePath, unit));
        }
      } else if (kind === 'STATIC_IMPORT') {
        found.push(...await importCandidates(base, group.artifactId, group.filePath, importRefs(await groupLinks(group)), (file) => fileKey(file.artifactId, file.filePath) === ownFile));
      } else {
        found.push(...await entryCandidates(base, group, lifecycleAction));
      }
    }
    if (context === 'INPUT') for (const candidate of found) await annotateInput(candidate);
    if (context === 'TRIGGER') for (const candidate of found) await annotateTrigger(group, candidate);
    return found;
  };

  /**
   * MISSING TRIGGER only: when a lifecycle or entry file calls an imported
   * function (`start()` from `./lib/runner`) instead of loading the group's file
   * itself, the complete definition of that export, offered only when it reaches
   * the group's file through a require or import, together with that statement.
   * A definition that does not reach the group's file is not offered. Nothing past
   * it is followed.
   */
  const triggerSecondHop = async ({ group, context, state }: UnresolvedContext, first: readonly ExpansionCandidate[]): Promise<ExpansionCandidate[]> => {
    const base: Base = { groupId: group.groupId, context, state, depth: 2 };
    const offered = new Set(first.map(candidateKey));
    const found: ExpansionCandidate[] = [];
    for (const origin of first) {
      for (const call of calledTriggers.get(origin) ?? []) {
        const file = await resolveFile(origin.artifactId, posix.join(posix.dirname(origin.filePath), call.ref.specifier));
        if (!file || isGroupFile(group, file)) continue;
        const lookup = exportUnits(codeOf(file), call.ref.symbol, parsed);
        if (!lookup?.matched) continue;
        const link = await groupFileImport(group, file, relativeImportsReachedBy(codeOf(file), lookup.units, parsed) ?? []);
        if (!link) continue;
        const units = [...lookup.units, link].sort((left, right) => left.startLine - right.startLine);
        const dependency = offerCandidate(base, 'STATIC_IMPORT', file, { units, statementAligned: true, symbol: call.ref.symbol });
        dependency.triggerSource = 'DIRECT';
        dependency.triggerUnit = link;
        const key = candidateKey(dependency);
        origin.triggerSource = 'CALL';
        origin.triggerUnit = call.unit;
        origin.dependsOn = key;
        if (!offered.has(key)) {
          offered.add(key);
          found.push(dependency);
        }
        break;
      }
    }
    return found;
  };

  /**
   * MISSING INPUT only: the complete definition of the one user function a
   * first-hop value statement calls (`payload = collect()`), in the same file
   * or behind a static import that names a findable export. Callbacks, dynamic
   * calls, aliases, re-exports and callers are not followed, and nothing past
   * this definition is.
   */
  const inputSecondHop = async ({ group, context, state }: UnresolvedContext, first: readonly ExpansionCandidate[]): Promise<ExpansionCandidate[]> => {
    const base: Base = { groupId: group.groupId, context, state, depth: 2 };
    const offered = new Set(first.map(candidateKey));
    const found: ExpansionCandidate[] = [];
    for (const origin of first) {
      const target = calledFunctions.get(origin);
      if (!target) continue;
      let dependency: ExpansionCandidate | undefined;
      if (target.kind === 'LOCAL') {
        const file = await readSource(origin.artifactId, origin.filePath);
        if (!file) continue;
        dependency = unitCandidate(base, 'LOCAL_FUNCTION', origin.artifactId, origin.filePath, target.unit);
        dependency.inputSource = definitionIsSelfContained(codeOf(file), [target.unit], parsed) ? 'DIRECT' : 'UNRESOLVED';
      } else {
        const file = await resolveFile(origin.artifactId, posix.join(posix.dirname(origin.filePath), target.ref.specifier));
        if (!file || isGroupFile(group, file)) continue;
        const lookup = exportUnits(codeOf(file), target.ref.symbol, parsed);
        // The called export cannot be pinned down, so no definition is offered and INPUT stays unresolved.
        if (!lookup?.matched) continue;
        dependency = offerCandidate(base, 'STATIC_IMPORT', file, { units: lookup.units, statementAligned: true, symbol: target.ref.symbol });
        dependency.inputSource = definitionIsSelfContained(codeOf(file), lookup.units, parsed) ? 'DIRECT' : 'UNRESOLVED';
      }
      const key = candidateKey(dependency);
      origin.dependsOn = key;
      if (offered.has(key)) continue;
      offered.add(key);
      found.push(dependency);
    }
    return found;
  };

  /**
   * The code the first-hop candidates' own statements link to directly. Lifecycle
   * and entry files are package-level and are not looked up again. A candidate
   * already offered (same artifact, file, range and symbol) is never offered
   * twice, and the group's own file is never re-entered through an import, which
   * also stops import cycles. Nothing found here is followed further.
   */
  const secondHop = async ({ group, context, state }: UnresolvedContext, first: readonly ExpansionCandidate[]): Promise<ExpansionCandidate[]> => {
    const base: Base = { groupId: group.groupId, context, state, depth: 2 };
    const kinds = EXPANSION_KINDS[context].filter((kind) => kind !== 'LIFECYCLE_ENTRY');
    const offered = new Set(first.map(candidateKey));
    const importedFiles = new Set(first.filter((candidate) => candidate.kind === 'STATIC_IMPORT')
      .map((candidate) => `${fileKey(candidate.artifactId, candidate.filePath)}:${candidate.symbol ?? ''}`));
    const ownFile = fileKey(group.artifactId, group.filePath);
    const found: ExpansionCandidate[] = [];
    const add = (candidate: ExpansionCandidate) => {
      const key = candidateKey(candidate);
      if (offered.has(key)) return;
      offered.add(key);
      found.push(candidate);
    };
    for (const origin of first) {
      input.signal?.throwIfAborted();
      const links = await linksOf(origin.artifactId, origin.filePath, origin.units);
      if (!links) continue;
      for (const kind of kinds) {
        if (kind === 'SAME_FILE_DEFINITION' || kind === 'LOCAL_FUNCTION') {
          for (const unit of kind === 'SAME_FILE_DEFINITION' ? links.definitions : links.functions) add(unitCandidate(base, kind, origin.artifactId, origin.filePath, unit));
          continue;
        }
        const candidates = await importCandidates(base, origin.artifactId, origin.filePath, importRefs(links), (file, ref) => {
          const key = `${fileKey(file.artifactId, file.filePath)}:${ref.symbol ?? ''}`;
          if (fileKey(file.artifactId, file.filePath) === ownFile || importedFiles.has(key)) return true;
          importedFiles.add(key);
          return false;
        });
        candidates.forEach(add);
      }
    }
    return found;
  };

  /** Every candidate carries how its context is explored and the model's original answer. */
  const stamp = (item: UnresolvedContext, candidates: ExpansionCandidate[]): ExpansionCandidate[] => {
    for (const candidate of candidates) {
      if (item.exploration !== undefined) candidate.exploration = item.exploration;
      if (item.answer !== undefined) candidate.answer = item.answer;
    }
    return candidates;
  };

  // MISSING first hop → MISSING second hop → PARTIAL first hop → LOW_CONFIDENCE_MISSING second hop.
  // A low-confidence context keeps its PARTIAL place; only its second hop is added, after everything else.
  const missingFirst: ExpansionCandidate[] = [];
  const missingSecond: ExpansionCandidate[] = [];
  const partialFirst: ExpansionCandidate[] = [];
  const lowConfidenceSecond: ExpansionCandidate[] = [];
  for (const item of input.unresolved.filter(({ state }) => state === 'MISSING')) {
    input.signal?.throwIfAborted();
    const first = stamp(item, await firstHop(item));
    missingFirst.push(...first);
    if (SECOND_HOP_CONTEXTS.includes(item.context)) missingSecond.push(...stamp(item, await secondHop(item, first)));
    else if (item.context === 'INPUT') missingSecond.push(...stamp(item, await inputSecondHop(item, first)));
    else if (item.context === 'TRIGGER') missingSecond.push(...stamp(item, await triggerSecondHop(item, first)));
  }
  for (const item of input.unresolved.filter(({ state }) => state !== 'MISSING')) {
    input.signal?.throwIfAborted();
    const first = stamp(item, await firstHop(item));
    partialFirst.push(...first);
    if (item.exploration !== 'LOW_CONFIDENCE_MISSING') continue;
    if (SECOND_HOP_CONTEXTS.includes(item.context)) lowConfidenceSecond.push(...stamp(item, await secondHop(item, first)));
    else if (item.context === 'INPUT') lowConfidenceSecond.push(...stamp(item, await inputSecondHop(item, first)));
  }
  return [...missingFirst, ...missingSecond, ...partialFirst, ...lowConfidenceSecond];
}
