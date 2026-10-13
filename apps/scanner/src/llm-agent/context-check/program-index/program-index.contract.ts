/**
 * Whole-package program index for the context check. Every supported source
 * file of the artifacts is parsed once per scan; modules, functions, calls and
 * value flows are indexed so a Finding can be followed back to what runs it
 * (TRIGGER) and to where its values come from (INPUT). Everything here is read
 * from source text only: no package code, script or binary is ever run.
 */

export const PROGRAM_FILE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'] as const;

/**
 * How firmly a relation is established. `CONFIRMED`: the source shows it
 * outright. `CONFIRMED_ASYNC`: shown, but it completes after the current
 * synchronous run (a settled `Promise.resolve().then()`, a literal dynamic
 * `import()`). `PROBABLE`: the shape suggests it and something could not be
 * checked. `UNRESOLVED`: not established; it is never taken as run.
 */
export type EvidenceLevel = 'CONFIRMED' | 'CONFIRMED_ASYNC' | 'PROBABLE' | 'UNRESOLVED';
export const EVIDENCE_RANK: Record<EvidenceLevel, number> = { CONFIRMED: 0, CONFIRMED_ASYNC: 1, PROBABLE: 2, UNRESOLVED: 3 };
export const weakestEvidence = (levels: readonly EvidenceLevel[]): EvidenceLevel => (
  levels.reduce<EvidenceLevel>((worst, level) => (EVIDENCE_RANK[level] > EVIDENCE_RANK[worst] ? level : worst), 'CONFIRMED')
);
/** Whether a relation of this level counts as actually run. */
export const isConfirmed = (level: EvidenceLevel): boolean => level === 'CONFIRMED' || level === 'CONFIRMED_ASYNC';

/** What a callback handed to a call is, as far as the source shows. Each refines the single `CALLBACK` position. */
export type CallbackKind =
  | 'SYNCHRONOUS_CALLBACK'
  | 'IMMEDIATE_INVOCATION'
  | 'PROMISE_MICROTASK'
  | 'LOCALLY_EMITTED_EVENT'
  | 'TIMER_CALLBACK'
  | 'EXTERNAL_EVENT_CALLBACK'
  | 'UNKNOWN_CALLBACK';

export interface FileRef { artifactId: string; filePath: string }
export interface LineRange { startLine: number; endLine: number }
/** One complete statement (or a function's declaration header) of one file. */
export interface StatementRef extends FileRef, LineRange { symbol?: string }

export type FileExclusionReason =
  | 'FILE_LIMIT' | 'TOTAL_BYTES_LIMIT' | 'FILE_REJECTED' | 'FILE_UNAVAILABLE' | 'WORK_LIMIT' | 'TIMEOUT';

export interface ProgramFile extends FileRef {
  bytes: number;
  lineCount: number;
  /** False when the file could not be parsed; it then contributes no symbols or edges. */
  parsed: boolean;
}

export type SymbolKind = 'MODULE' | 'FUNCTION' | 'METHOD' | 'CALLBACK';

/** The top level of a file (`MODULE`) or one function body in it. */
export interface ProgramSymbol extends FileRef, LineRange {
  id: string;
  kind: SymbolKind;
  name?: string;
  /** Lines from the start of the function to the start of its body. */
  header?: LineRange;
  /** Enclosing function, or the file's module symbol. Absent for a module. */
  parentId?: string;
  /** `process.exit()`, `process.abort()` and `throw` statements directly in this body, by line. */
  terminatorLines: number[];
}

export type ModuleEdgeKind = 'REQUIRE' | 'IMPORT' | 'DYNAMIC_IMPORT' | 'REEXPORT';

export interface ModuleEdge {
  from: FileRef;
  /** Module or function whose body holds the import. */
  inSymbolId: string;
  statement: StatementRef;
  kind: ModuleEdgeKind;
  /** Null when the path is computed. */
  specifier: string | null;
  resolution: 'RESOLVED' | 'EXTERNAL' | 'UNRESOLVED';
  to?: FileRef;
  unresolvedReason?: 'COMPUTED_SPECIFIER' | 'TARGET_NOT_FOUND' | 'OUTSIDE_ARTIFACT' | 'TARGET_NOT_PARSED';
}

export interface ExportRecord extends FileRef {
  /** `default` for `module.exports = …` and `export default`. */
  name: string;
  statement: StatementRef;
  /** Set when the name is forwarded from another module. */
  reexportOf?: { specifier: string; name: string | '*' };
}

export type CallEdgeKind = 'CALL' | 'IMMEDIATE_CALL' | 'CONSTRUCT' | 'CALLBACK' | 'MODULE_LOAD';
export type EnclosingKind = 'CONDITION' | 'RUN_DIRECTLY' | 'LOOP' | 'TRY' | 'OTHER';

export interface CallEdge {
  callerId: string;
  /** Absent when the callee could not be tied to a symbol. */
  calleeId?: string;
  calleeName?: string;
  kind: CallEdgeKind;
  /** The complete statement that makes the call, registers the callback, emits the event or loads the module. */
  site: StatementRef;
  /** Statements that tie the site to the callee: import and export statements, aliases, a callback's registration. */
  links: StatementRef[];
  evidence: EvidenceLevel;
  callbackKind?: CallbackKind;
  /** The callee runs after the current synchronous run, or only when something outside the code fires. */
  asyncBoundary: boolean;
  /** Statement around the site in the same body: the call is made only as that statement decides. */
  within?: LineRange & { kind: EnclosingKind };
  unresolvedReason?: string;
  /** What the evidence level rests on, e.g. `STATIC_CALLEE`, `ARRAY_RECEIVER`, or the reason it is not established. */
  basis?: string;
  /** CALLBACK only: where the callback is handed over and, when the source shows it, where it is run. */
  registeredAt?: StatementRef;
  executedAt?: StatementRef;
}

export type DataFlowEdgeKind =
  | 'INITIALIZER' | 'ASSIGNMENT' | 'ALIAS' | 'DESTRUCTURING' | 'ARGUMENT_TO_PARAMETER' | 'RETURN' | 'CLOSURE'
  | 'PROPERTY_READ' | 'PROPERTY_WRITE' | 'IMPORT_EXPORT' | 'COMPOSITION' | 'PROMISE_RESULT' | 'CALLBACK_ARGUMENT' | 'UNRESOLVED';

/** A value moving from `from` (where it is produced) to `to` (where it is used). */
export interface DataFlowEdge {
  kind: DataFlowEdgeKind;
  from?: StatementRef;
  to: StatementRef;
  /** Variable, parameter or property the value is held in at `to`. */
  name?: string;
  evidence: EvidenceLevel;
  unresolvedReason?: string;
}

/**
 * What a path starts from. `LIFECYCLE` and `ENTRY_POINT` run at install or when
 * the package is loaded. `SCRIPT`: a file another npm script runs.
 * `EXPORTED_API`: a function the package exports and does not call itself.
 * `UNREFERENCED`: a file nothing loads, or a function nothing in the package calls.
 */
export type TriggerRootKind = 'LIFECYCLE' | 'ENTRY_POINT' | 'SCRIPT' | 'EXPORTED_API' | 'UNREFERENCED';
export const ROOT_RANK: Record<TriggerRootKind, number> = { LIFECYCLE: 0, ENTRY_POINT: 1, SCRIPT: 2, EXPORTED_API: 3, UNREFERENCED: 4 };
export interface TriggerRoot extends FileRef { kind: TriggerRootKind; /** Script name, entry point type, or the name of the function. */ name: string }

export interface TriggerWitnessStep {
  kind: CallEdgeKind;
  callerSymbol?: string;
  calleeSymbol?: string;
  site: StatementRef;
  links: StatementRef[];
  evidence: EvidenceLevel;
  callbackKind?: CallbackKind;
  asyncBoundary: boolean;
  within?: LineRange & { kind: EnclosingKind };
  unresolvedReason?: string;
  basis?: string;
  registeredAt?: StatementRef;
  executedAt?: StatementRef;
}

/**
 * The path from a root to a Finding. `CONFIRMED`: a root of any kind is
 * reached with no unresolved step; `evidence` is the weakest step and `root`
 * says what kind of start it is. `INCOMPLETE`: the path ends at a step that
 * cannot be followed; `incomplete` says where. `UNCONFIRMED` is no longer produced.
 */
export interface TriggerWitness {
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'INCOMPLETE';
  finding: StatementRef;
  root?: TriggerRoot;
  /** Root first, Finding last. */
  steps: TriggerWitnessStep[];
  evidence: EvidenceLevel;
  asyncBoundary: boolean;
  incomplete?: { symbol?: string; file: FileRef; reason: string };
  /** Every statement of the path in path order, without repeats; the Finding's own statement last. */
  statements: StatementRef[];
  /** Limits the search ran into: `DEPTH_LIMIT`, `PROBABLE_EDGE_LIMIT`, `UNRESOLVED_EDGE`, `VISITED_SYMBOL_LIMIT`, `SEARCH_TIMEOUT`. */
  limitations: string[];
  /** Longest path the search followed, in steps. */
  exploredDepth: number;
  /** Probable steps of the reported path. */
  probableEdgeCount: number;
  conditional: ConditionalEligibility;
}

/**
 * Where the values a Finding uses come from. `COMPLETE`: every traced value
 * ends at a direct source (a literal, a global, a built-in call, an external
 * module) with no unresolved step. `INCOMPLETE`: at least one step could not be
 * followed. `NONE`: the Finding's statement uses no traceable value.
 */
export interface InputWitness {
  status: 'COMPLETE' | 'INCOMPLETE' | 'NONE';
  finding: StatementRef;
  edges: DataFlowEdge[];
  /** Every statement the flow passes through, in the order it was followed; the Finding's own statement is not repeated. */
  statements: StatementRef[];
  unresolved: Array<{ at: StatementRef; reason: string }>;
  limitations: string[];
  /** Deepest step of the flow that was followed. */
  exploredDepth: number;
  /** Probable edges of the flow. */
  probableEdgeCount: number;
  conditional: ConditionalEligibility;
}

export interface ProgramIndexDiagnostics {
  candidateFileCount: number;
  parsedFileCount: number;
  parseFailureCount: number;
  excludedFiles: Array<FileRef & { reason: FileExclusionReason }>;
  totalSourceBytes: number;
  symbolCount: number;
  callEdgeCount: number;
  moduleEdgeCount: number;
  unresolvedModuleEdgeCount: number;
  /** Limits that stopped part of the analysis, e.g. `FILE_LIMIT`, `TIMEOUT`. */
  appliedLimits: string[];
  limitations: string[];
  durationMs: number;
  /** Measurement-only phase timings; they do not affect index construction. */
  timing?: {
    artifactDiscoveryMs: number;
    sourceReadMs: number;
    astParseMs: number;
    graphBuildMs: number;
  };
}

/**
 * Limits of one index build and of each witness search. Exceeding one never
 * fails the check: the analysis stops there and the limit is recorded.
 */
export const PROGRAM_INDEX_LIMITS = {
  maxFiles: 3_000,
  maxTotalSourceBytes: 32 * 1024 * 1024,
  maxAstNodes: 3_000_000,
  /** Steps a path of confirmed steps is followed for; the same for a value flow. */
  maxCallDepth: 16,
  maxDataFlowDepth: 16,
  /** Steps a path, or a value flow, that holds a probable step is followed for. */
  maxProbableDepth: 16,
  maxVisitedSymbols: 800,
  /** Paths that reach a root which are compared before the search of one Finding ends. */
  maxWitnessPaths: 8,
  /** Time one witness search may take. */
  witnessSearchTimeoutMs: 250,
  buildTimeoutMs: 10_000,
} as const;

export interface ProgramIndexLimits {
  maxFiles: number;
  maxTotalSourceBytes: number;
  maxFileSizeBytes: number;
  maxAstNodes: number;
  maxCallDepth: number;
  maxDataFlowDepth: number;
  maxProbableDepth: number;
  maxVisitedSymbols: number;
  maxWitnessPaths: number;
  witnessSearchTimeoutMs: number;
  buildTimeoutMs: number;
}

/**
 * Whether the model's answer may settle a witness that is not confirmed end to
 * end. Eligible only with exactly one probable step, every other step
 * confirmed, and no dynamic import, computed dispatch, outside event, timer or
 * unconfirmed promise callback on the way.
 */
export interface ConditionalEligibility { eligible: boolean; reason: string }

export const fileKey = (ref: FileRef): string => `${ref.artifactId}\u0000${ref.filePath}`;
export const statementKey = (item: FileRef & LineRange): string => `${fileKey(item)}\u0000${item.startLine}\u0000${item.endLine}`;
