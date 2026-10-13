import type { ExecutionStep, FindingPosition } from './code-units';
import type { CallbackKind, EvidenceLevel, TriggerRootKind } from './program-index/program-index.contract';

/**
 * Agent Planning context check: before the Tier 3 Agent runs, a System One model
 * (Jev) rates once whether the supplied slices show each context of a Finding
 * group. Scanner then adds directly linked code for the contexts that are not
 * visible. The model only rates; candidates, budgets and slices stay deterministic.
 */

export const CONTEXT_CODES = ['TRIGGER', 'INPUT', 'ACTION', 'TARGET', 'LINK'] as const;
export type ContextCode = (typeof CONTEXT_CODES)[number];

export type ContextState = 'VISIBLE' | 'PARTIAL' | 'MISSING';

/** Order is the tie-break order of groups and the order of the mapping tables. */
export const BEHAVIOR_GROUPS = [
  'NETWORK_SEND', 'COLLECT_AND_SEND', 'SENSITIVE_READ', 'ENVIRONMENT_READ', 'DOWNLOAD', 'DOWNLOAD_AND_EXECUTE', 'REMOTE_SHELL', 'PROCESS_EXEC',
  'FILE_MUTATION', 'LIFECYCLE', 'PERSISTENCE', 'SURVEILLANCE', 'SYSTEM_DISCOVERY', 'PROPAGATION', 'DYNAMIC_CODE', 'OTHER',
  'OBFUSCATION_SIGNAL', 'PACKAGE_RISK',
] as const;
export type BehaviorGroup = (typeof BEHAVIOR_GROUPS)[number];

/** Behavior groups that are never asked: obfuscation markers and package-level indicators. */
export const UNASKED_BEHAVIOR_GROUPS = ['OBFUSCATION_SIGNAL', 'PACKAGE_RISK'] as const;
export type UnaskedBehaviorGroup = (typeof UNASKED_BEHAVIOR_GROUPS)[number];
export type AskedBehaviorGroup = Exclude<BehaviorGroup, UnaskedBehaviorGroup>;

/**
 * Tier 2 `obfuscation.*` Findings describe detection and restoration, not a
 * behavior. They are routed here instead of into a behavior group. A partial
 * restore is reported under the same rule as a full one; telling them apart needs
 * restore details that the Tier 3 Finding projection does not carry yet (#458).
 */
export type RestorationStatus = 'RESTORED' | 'UNRESOLVED' | 'NOT_SELECTED' | 'DETECTED' | 'TECHNIQUE';

/** Selection rank of a group, 1 first: composite threat, single threat, lifecycle/persistence/propagation, capability, noisy custom. */
export type GroupPriority = 1 | 2 | 3 | 4 | 5;

/** Findings of one behavior group observed in one file of one artifact. */
export interface FindingGroup {
  groupId: string;
  artifactId: string;
  filePath: string;
  behavior: BehaviorGroup;
  findingIds: string[];
  contexts: ContextCode[];
  priority: GroupPriority;
}

/** `UNSUPPORTED_MATCH`: the rule labels the Findings as user input, but their lines hold no clipboard or key-event API. */
export type SkippedGroupReason = 'UNSUPPORTED_FILE' | 'GROUP_LIMIT' | 'INPUT_LIMIT' | 'UNSUPPORTED_MATCH';

/** A group that would have been asked but was not, and why. */
export interface SkippedGroupRecord {
  filePath: string;
  behavior: BehaviorGroup;
  findingIds: string[];
  reason: SkippedGroupReason;
}

/** Static-filter reasons tied to a group's Findings that add no context; kept so they are not lost. */
export interface PreservedReasonRecord {
  filePath: string;
  behavior: BehaviorGroup;
  findingIds: string[];
  reasonCodes: string[];
}

/** Final restoration state of one file, with the techniques detected in it. */
export interface RestorationStatusRecord {
  filePath: string;
  status: Exclude<RestorationStatus, 'TECHNIQUE'>;
  techniques: string[];
  /** OBFUSCATION_SIGNAL Findings observed in the same file. */
  signalFindingIds: string[];
}

export interface ScoreQuestion { type: 'score'; instructions: string; criteria: string[] }
export interface ContextCheckRequest { state: unknown; questions: Record<string, ScoreQuestion> }
export interface ScoreAnswer { score: number; confidence: number }
export interface ContextCheckUsage { inputTokens?: number; outputTokens?: number }
export interface ContextCheckResponse { model: string; answers: Record<string, ScoreAnswer>; usage: ContextCheckUsage }

export interface ContextCheckProvider {
  check(request: ContextCheckRequest, signal?: AbortSignal): Promise<ContextCheckResponse>;
}

export type ContextCheckProviderFailure = 'NOT_CONFIGURED' | 'TIMEOUT' | 'TRANSPORT' | 'HTTP' | 'INVALID_RESPONSE';
export class ContextCheckProviderError extends Error {
  constructor(message: string, readonly reason: ContextCheckProviderFailure) { super(message); }
}

/** `WITNESS_PATH`: a statement of a witness path the program index found for one of the group's Findings. */
export type ExpansionKind = 'SAME_FILE_DEFINITION' | 'LOCAL_FUNCTION' | 'STATIC_IMPORT' | 'LIFECYCLE_ENTRY' | 'EXECUTION_PATH' | 'WITNESS_PATH' | 'ENCLOSING_FUNCTION';

/** One directly linked code range that could make an unresolved context visible. */
export interface ExpansionCandidate {
  groupId: string;
  context: ContextCode;
  state: Exclude<ContextState, 'VISIBLE'>;
  kind: ExpansionKind;
  /** 1: linked from the supplied slices; 2: linked from a first-hop candidate (MISSING contexts only; see `generateExpansionCandidates`). */
  depth: 1 | 2;
  artifactId: string;
  filePath: string;
  /** Span of `units`. */
  startLine: number;
  endLine: number;
  /**
   * The complete statements this candidate offers, in line order. Validation
   * selects whole statements only; it never cuts one.
   */
  units: Array<{ startLine: number; endLine: number; executable?: boolean }>;
  /** False for the fallback range of a file that could not be read as statements. */
  statementAligned: boolean;
  /** Variable, function or imported name the candidate was found through, when there is one. */
  symbol?: string;
  /** What a statement supplied before the model is asked is: on the way from the file load to the Finding, or on the way of a value into it. */
  pathPurpose?: 'CALL_SITE' | 'FINDING_STATEMENT' | 'VALUE_FLOW';
  /** Set when the candidate is known not to help its context; validation records it without using a slot or lines. */
  exclusion?: 'SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE' | 'SELF_ENTRY_FILE_NOT_TRIGGER_EVIDENCE';
  /**
   * TRIGGER only: whether the offered lifecycle or entry code shows a path to
   * the group's file. `DIRECT`: `triggerUnit` requires or imports the group's
   * file. `CALL`: `triggerUnit` calls an imported function whose definition, the
   * candidate `dependsOn` names, requires the group's file (a second-hop
   * candidate is `DIRECT` with that require statement as `triggerUnit`).
   * `UNLINKED`: no path is shown.
   */
  triggerSource?: 'DIRECT' | 'CALL' | 'UNLINKED';
  triggerUnit?: { startLine: number; endLine: number };
  /**
   * INPUT only: what the offered statements show about where the value comes
   * from. `CALL` needs the called function's complete definition, which the
   * candidate `dependsOn` names (absent when that definition was not found or
   * not looked up).
   */
  inputSource?: 'DIRECT' | 'CALL' | 'UNRESOLVED';
  dependsOn?: string;
  /** How the context this candidate serves is explored (see `ExplorationClass`). */
  exploration?: ExplorationClass;
  /** The model's original answer for that context. */
  answer?: { score: number; confidence: number };
}

export type CandidateExclusionReason =
  | 'ALREADY_COVERED'
  | 'DUPLICATE'
  | 'NO_MEANINGFUL_CODE'
  | 'PARTIAL_STATEMENT'
  | 'SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE'
  | 'SELF_ENTRY_FILE_NOT_TRIGGER_EVIDENCE'
  | 'INVALID_RANGE'
  | 'UNSUPPORTED_ARTIFACT'
  | 'FILE_READ_FAILED'
  | 'TARGET_LIMIT'
  | 'LINE_BUDGET_EXCEEDED';

/**
 * What candidate validation did with one candidate. Diagnostic only: it holds no
 * code and is never sent to the Agent, the model or Policy, nor kept in the
 * Shadow record. `lineCount` counts the selected lines when selected, else the
 * candidate's.
 */
export interface CandidateTraceEntry {
  groupId: string;
  context: ContextCode;
  depth: 1 | 2;
  kind: ExpansionKind;
  artifactId: string;
  filePath: string;
  candidateStartLine: number;
  candidateEndLine: number;
  selectedStartLine: number | null;
  selectedEndLine: number | null;
  lineCount: number;
  symbol?: string;
  selected: boolean;
  exclusionReason: CandidateExclusionReason | null;
  /** Whether the context was explored as `LOW_CONFIDENCE_MISSING`. */
  lowConfidenceMissing: boolean;
  /** The model's original answer for the context; null when it is not known. */
  score: number | null;
  confidence: number | null;
}

export interface ContextStateRecord {
  groupId: string;
  filePath: string;
  behavior: BehaviorGroup;
  context: ContextCode;
  state: ContextState;
  score: number;
  confidence: number;
}

/**
 * `CONDITIONAL_START` (TRIGGER only): a confirmed path lies in the slices, but it starts at an npm script, an exported
 * function or an unreferenced file, which run only when someone runs or calls them. `DIRECT`: no complete path, but
 * the whole statement of every Finding is in the slices (INPUT, ACTION, TARGET only).
 */
export type WitnessSupport = 'CONFIRMED' | 'CONDITIONAL_START' | 'DIRECT' | 'PROBABLE' | 'UNRESOLVED';

/** A selected static witness whose required syntax is absent from the final slices. */
export interface WitnessSliceError {
  groupId: string;
  context: ContextCode;
  pathId: string;
  reason: 'SELECTED_WITNESS_NOT_IN_SLICES';
  missing: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
}

export type ContextCheckStatus =
  | 'DISABLED'
  | 'NO_GROUPS'
  | 'INPUT_TOO_LARGE'
  | 'UNAVAILABLE'
  | 'SUFFICIENT'
  | 'NO_BUDGET'
  | 'EXPANDED'
  | 'NO_CANDIDATE'
  | 'EXPANSION_FAILED';

/** Shadow record of one context check; it is never sent to Policy or the Agent. */
/**
 * Whether a TRIGGER question is asked when a lifecycle script runs the group's
 * file itself. `OMIT_WHEN_RUN_AT_LOAD` (default): left out only when every
 * Finding of the group lies in code that runs when the file is loaded.
 * `OMIT_WHEN_RUN_BY_LIFECYCLE` and `ASK` exist for measurement runs.
 */
export type LifecycleTriggerQuestion = 'OMIT_WHEN_RUN_AT_LOAD' | 'OMIT_WHEN_RUN_BY_LIFECYCLE' | 'ASK';

/**
 * A question that was not sent because Scanner already holds the fact it would
 * ask about. The context has no state: it is neither VISIBLE nor missing.
 */
export interface OmittedQuestionRecord {
  groupId: string;
  filePath: string;
  behavior: BehaviorGroup;
  context: 'TRIGGER' | 'INPUT' | 'LINK';
  /**
   * `NO_TRACEABLE_VALUE` (INPUT): every Finding statement of the group passes literals only, so there is no value whose origin could be shown.
   * `NOTHING_TO_LINK` (LINK): on top of that, every Finding statement is the operation call itself.
   */
  reason: 'LIFECYCLE_RUNS_FILE_AT_LOAD' | 'LIFECYCLE_RUNS_FILE' | 'NO_TRACEABLE_VALUE' | 'NOTHING_TO_LINK';
  /** Lifecycle scripts whose command runs the file; empty for INPUT and LINK. */
  scripts: string[];
}

/**
 * How the execution evidence reaches the model. The evidence is computed and
 * recorded in every mode.
 *
 * `INSTRUCTION_WITH_PATH` (default): the evidence is written into the TRIGGER
 * question only, so `state` and every other question stay as they are without
 * it, and the call sites and Finding statements the supplied slices lack are
 * added as slices and quoted in that question.
 * `INSTRUCTION`: the same without those statements.
 * `STATE`, `STATE_AND_INSTRUCTION`: the evidence sits in the shared `state`,
 * where it also reaches the other questions. `NONE`: not sent. These three and
 * `INSTRUCTION` exist for measurement runs.
 */
export type TriggerEvidenceMode = 'NONE' | 'STATE' | 'STATE_AND_INSTRUCTION' | 'INSTRUCTION' | 'INSTRUCTION_WITH_PATH';

/** A statement on the way from the file load to a Finding that was added as a slice because the supplied slices lacked it. */
export interface ExecutionPathStatementRecord {
  groupId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  purpose: 'CALL_SITE' | 'FINDING_STATEMENT' | 'VALUE_FLOW';
}

export interface FindingExecutionRecord {
  findingId: string;
  ruleId: string;
  startLine: number | null;
  /** The complete statement the Finding's line belongs to, when the file can be read as statements. */
  statement: { startLine: number; endLine: number } | null;
  position: FindingPosition;
  /** Calls and callback registrations from the file load to the Finding, outermost first. */
  steps: ExecutionStep[];
  /** A function starts on the Finding line and continues: the Finding is read as the statement, and the function body is not taken as run. */
  callbackStartsOnLine?: true;
  /** The path from a lifecycle or entry file to the Finding across files, when the program index was built. */
  reach?: TriggerReachRecord;
  /** Other paths that reach a root, best first; `reach` is the best one. */
  reachAlternatives?: TriggerReachRecord[];
}

/** One step of a path across files. Holds positions and names only, never code. */
export interface TriggerReachStep {
  kind: 'CALL' | 'IMMEDIATE_CALL' | 'CONSTRUCT' | 'CALLBACK' | 'MODULE_LOAD';
  artifactId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  calleeSymbol?: string;
  evidence: EvidenceLevel;
  callbackKind?: CallbackKind;
  within?: { kind: 'CONDITION' | 'RUN_DIRECTLY' | 'LOOP' | 'TRY' | 'OTHER'; startLine: number; endLine: number };
  unresolvedReason?: string;
  /** What the evidence level rests on. */
  basis?: string;
  /** CALLBACK only: where the callback is handed over and where it is run, when the source shows that. */
  registeredAt?: { filePath: string; startLine: number; endLine: number };
  executedAt?: { filePath: string; startLine: number; endLine: number };
}

/**
 * What the program index established about how a Finding is reached from what
 * runs the package. `CONFIRMED` only when every step from a lifecycle or entry
 * file to the Finding is shown as run; a callback that is merely registered, a
 * timer and an outside event keep it `UNCONFIRMED`; `INCOMPLETE` when no such
 * file is reached.
 */
export interface TriggerReachRecord {
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'INCOMPLETE';
  evidence: EvidenceLevel;
  /** A step completes after the current synchronous run. */
  asyncBoundary: boolean;
  root?: { kind: 'LIFECYCLE' | 'ENTRY_POINT' | 'SCRIPT' | 'EXPORTED_API' | 'UNREFERENCED'; name: string; filePath: string };
  steps: TriggerReachStep[];
  /** Every statement of the path, root first, the Finding's own statement last. */
  statements: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
  incompleteReason?: string;
  /** Longest path the search followed, in steps. */
  exploredDepth: number;
  probableEdgeCount: number;
  /** Limits the search ran into: `DEPTH_LIMIT`, `PROBABLE_EDGE_LIMIT`, `UNRESOLVED_EDGE`, `VISITED_SYMBOL_LIMIT`, `SEARCH_TIMEOUT`. */
  limits: string[];
  conditional: ConditionalResolutionRecord;
}

/**
 * Whether a path with exactly one probable step was settled by the model's
 * answer. `eligible`: the path qualifies (one probable step, the rest
 * confirmed, no dynamic import, computed dispatch, outside event, timer or
 * unconfirmed promise callback). `resolved`: it qualifies, every statement of
 * it is in the slices, and the answer for the context reached the score for
 * VISIBLE with at least `conditionalResolutionMinConfidence`. `reason` says
 * which of these decided it.
 */
export interface ConditionalResolutionRecord { eligible: boolean; resolved: boolean; reason: string }

/** What the program index established about where the values of one Finding come from. Holds no code. */
export interface InputWitnessRecord {
  groupId: string;
  findingId: string;
  status: 'COMPLETE' | 'INCOMPLETE' | 'NONE';
  edgeCount: number;
  statements: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
  unresolvedReasons: string[];
  exploredDepth: number;
  probableEdgeCount: number;
  limits: string[];
  conditional: ConditionalResolutionRecord;
}

export type WitnessFailureReason =
  | 'NO_COMPLETE_PATH' | 'COMPOSITE_INCOMPLETE' | 'TARGET_BUDGET' | 'LINE_BUDGET' | 'DEPTH_LIMIT' | 'PROBABLE_EDGE_LIMIT' | 'EXTERNAL_BOUNDARY' | 'DYNAMIC_DISPATCH';

export interface CompositeWitness {
  behavior: 'COLLECT_AND_SEND' | 'DOWNLOAD_AND_EXECUTE' | 'REMOTE_SHELL';
  status: 'COMPLETE' | 'PARTIAL';
  requiredStages: string[];
  confirmedStages: string[];
  missingStages: string[];
  /** Required stage-to-stage value/call links that static tracing did not establish. */
  missingConnections: string[];
  stageWitnesses: Array<{
    stage: string;
    family: string;
    sink: { artifactId: string; filePath: string; startLine: number; endLine: number; callee?: string };
    steps: Array<{ kind: string; evidence: EvidenceLevel; basis?: string; statement: { artifactId: string; filePath: string; startLine: number; endLine: number } }>;
    statements: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
  }>;
  connectionWitnesses: Array<{
    fromStage: string;
    toStage: string;
    kind: 'VALUE_FLOW' | 'NESTED_CALL';
    steps: Array<{ kind: string; evidence: EvidenceLevel; basis?: string; statement: { artifactId: string; filePath: string; startLine: number; endLine: number } }>;
    statements: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
  }>;
  complete: boolean;
}

/**
 * `DUPLICATE_PATH`: a better path of the same group and context has the same statements or ends at the same sink.
 * `DUPLICATE_EVIDENCE`: the paths already added hold every line of it.
 */
export type WitnessExclusionReason = WitnessFailureReason | 'DUPLICATE_PATH' | 'DUPLICATE_EVIDENCE' | 'ALREADY_IN_SLICES';

/**
 * One witness path of one Finding for one context, start to end. `complete`:
 * start and end are connected with no unresolved step and at most one probable
 * step. A complete path is added to the slices whole or not at all. Holds no code.
 */
export interface ContextWitnessPath {
  /** Unique within one check. */
  pathId: string;
  context: ContextCode;
  groupId: string;
  findingId: string;
  complete: boolean;
  steps: Array<{ kind: string; evidence: EvidenceLevel; basis?: string; statement: { artifactId: string; filePath: string; startLine: number; endLine: number } }>;
  /** Steps shown as run, including the ones counted in `confirmedAsyncEdgeCount`. */
  confirmedEdgeCount: number;
  confirmedAsyncEdgeCount: number;
  probableEdgeCount: number;
  depth: number;
  statements: Array<{ artifactId: string; filePath: string; startLine: number; endLine: number }>;
  /** ACTION, TARGET, LINK: the operation call the path ends at. */
  sink?: { artifactId: string; filePath: string; startLine: number; endLine: number; callee?: string };
  /** TRIGGER: where the path starts, when it reaches a start. */
  rootKind?: TriggerRootKind;
  /** Multi-operation ACTION evidence, when the behavior requires a connected composition. */
  composite?: CompositeWitness;
  failureReason?: WitnessFailureReason;
  /** Position among the paths of the same group and context, best first; set when the path was offered for selection. */
  rank?: number;
  /** Order in which the path was added, counted over the whole check. */
  selectionOrder?: number;
  /** Why the path was not added. */
  exclusionReason?: WitnessExclusionReason;
  /** Targets and lines the path took when it was added. */
  newTargetCount: number;
  newLineCount: number;
  /** `NOT_NEEDED`: its context was visible, so nothing was looked up. */
  /** `OFFERED_INCOMPLETE`: the path is not complete and what was found of it was offered statement by statement. */
  outcome: 'ADDED' | 'ALREADY_IN_SLICES' | 'NOT_ADDED' | 'NOT_NEEDED' | 'OFFERED_INCOMPLETE';
}

/** Outcome of the whole-package index build of one check. */
export interface ProgramIndexRecord {
  status: 'BUILT' | 'UNAVAILABLE' | 'NOT_REQUESTED';
  candidateFileCount: number;
  parsedFileCount: number;
  parseFailureCount: number;
  excludedFileCount: number;
  totalSourceBytes: number;
  symbolCount: number;
  callEdgeCount: number;
  moduleEdgeCount: number;
  unresolvedModuleEdgeCount: number;
  appliedLimits: string[];
  limitations: string[];
  durationMs: number;
  timing?: {
    artifactDiscoveryMs: number;
    sourceReadMs: number;
    astParseMs: number;
    graphBuildMs: number;
  };
}

/** Measurement diagnostics only; none of these values affect the result. */
export interface ContextCheckTiming {
  artifactDiscoveryMs: number;
  sourceReadMs: number;
  astParseMs: number;
  graphBuildMs: number;
  witnessSearchMs: number;
  candidateValidationMs: number;
  witnessSelectionMs: number;
  sliceRebuildMs: number;
  jevInitialMs: number;
  jevRecheckMs: number;
  totalMs: number;
}

/** What Scanner established statically about how the Findings of one group are reached. Holds no code. */
export interface GroupExecutionEvidence {
  groupId: string;
  filePath: string;
  behavior: BehaviorGroup;
  /** Lifecycle scripts whose command runs the file itself. */
  runByLifecycle: string[];
  /** Entry point types that name the file itself. */
  runAsEntryPoint: string[];
  /** The least certain position among the group's Findings. */
  position: FindingPosition;
  findings: FindingExecutionRecord[];
}

/**
 * `RESOLVED`: the second answer is VISIBLE. `IMPROVED_UNRESOLVED`: the score rose but the answer is not VISIBLE.
 * `REGRESSED`: the score fell. `UNRESOLVED`: neither. `RECHECK_UNAVAILABLE`: the second call gave no answer.
 */
export type RecheckOutcome = 'RESOLVED' | 'UNRESOLVED' | 'IMPROVED_UNRESOLVED' | 'REGRESSED' | 'RECHECK_UNAVAILABLE';
export interface RecheckAnswerRecord { score: number; confidence: number; state: ContextState }
export interface RecheckQuestionRecord {
  groupId: string;
  context: ContextCode;
  /** Code was added for the context itself, or for a context that bears on it. */
  reason: 'CODE_ADDED' | 'RELATED_CONTEXT_ADDED';
  first: RecheckAnswerRecord;
  second?: RecheckAnswerRecord;
  outcome: RecheckOutcome;
  failureReason?: string;
  /** Whether the context is still reported to Tier 3 once both answers are merged. */
  unresolved: boolean;
}

/** A context Scanner settled by a path, asked again with the final slices for the record only; the decision is not changed. */
export interface ScannerSettledCheckRecord {
  groupId: string;
  context: ContextCode;
  first: { score: number; confidence: number };
  second?: { score: number; confidence: number };
  /** The second answer reaches the VISIBLE score. */
  agreed: boolean;
}

/** The second call, made with the final slices when `LLM_AGENT_CONTEXT_RECHECK_ENABLED` is on. `states` keeps the first answers. */
export interface ContextRecheckRecord {
  questions: RecheckQuestionRecord[];
  /** Asked in the second request of a group that had open questions; a group without any gets no request for these alone. */
  scannerSettled?: ScannerSettledCheckRecord[];
  /** Open questions left out of the second request because no answer could settle them with the final slices. */
  skippedUnsettleable?: number;
  /** Provider calls made: one per artifact-file batch asked again, except oversized batches split back into groups. */
  callCount: number;
  failedCallCount: number;
  timeoutCallCount?: number;
  /** Slices left out of second requests that would otherwise have been too large. */
  trimmedSliceCount?: number;
  latencyMs: number;
  usage: ContextCheckUsage;
  model?: string;
  failureReason?: string;
}

export interface ContextCheckRecord {
  status: ContextCheckStatus;
  groupCount: number;
  states: ContextStateRecord[];
  addedTargetCount: number;
  addedSliceCount: number;
  addedLineCount: number;
  unresolvedContextCount: number;
  skippedGroups: SkippedGroupRecord[];
  preservedReasons: PreservedReasonRecord[];
  restorationStatus: RestorationStatusRecord[];
  omittedQuestions: OmittedQuestionRecord[];
  executionEvidence: GroupExecutionEvidence[];
  executionPathStatements: ExecutionPathStatementRecord[];
  /** Whole-package index the check worked with; absent in records written before it existed. */
  programIndex?: ProgramIndexRecord;
  /** INPUT flows traced for the groups whose INPUT was not visible. */
  inputWitnesses?: InputWitnessRecord[];
  /** Witness paths of all five contexts and what became of each. */
  witnessPaths?: ContextWitnessPath[];
  recheck?: ContextRecheckRecord;
  /** Contexts settled by a fully supplied CONFIRMED path, or by a qualifying PROBABLE path and answer. */
  witnessResolved?: Array<{ groupId: string; context: ContextCode }>;
  /** Runner/slice failures are recorded separately and never treated as confidence failures. */
  witnessSliceErrors?: WitnessSliceError[];
  model?: string;
  usage?: ContextCheckUsage;
  failureReason?: string;
  timing?: ContextCheckTiming;
}

export const CONTEXT_CHECK_LIMITS = {
  /** Score levels are 0 (absent), 1 (partial), 2 (visible). */
  visibleMinScore: 1.2,
  missingMaxScore: 0.5,
  /** Kept for low-confidence MISSING exploration; VISIBLE uses the two score-dependent floors below. */
  minConfidence: 0,
  /** A marginal VISIBLE score needs this confidence. */
  visibleMinConfidence: 0.3,
  /** A stronger score may use the lower confidence floor below. */
  strongVisibleMinScore: 1.5,
  strongVisibleMinConfidence: 0.2,
  /** A TRIGGER path with this many probable steps at most is settled by an answer with at least the score and confidence below. */
  triggerProbableMaxEdges: 2,
  triggerProbableMinScore: 1.5,
  triggerProbableMinConfidence: 0.4,
  /** Conservative character budget for the 32k-token `state` limit. */
  maxStateChars: 90_000,
  maxGroups: 12,
  maxLinesPerCandidate: 120,
  /** Lines one lifecycle or entry file may add when no path to the Finding was found; it is not chosen for the Finding. */
  maxFallbackLines: 40,
  /** Lines the expansion may add in all, as far as the total code budget allows. */
  maxExpansionLines: 480,
  /**
   * Targets the expansion may add. They are counted apart from the INITIAL slice
   * limit, so a path that spans several files can be shown statement by
   * statement; the lines they may hold together are unchanged.
   */
  maxExpansionTargets: 80,
  /** Entries listed per kind of note in `missingData`; the rest is summarized in one line. */
  maxNotesPerKind: 12,
  /** Added ranges named in one question of the second request. */
  maxRecheckHintRanges: 8,
} as const;

/**
 * Internal exploration policy for answers whose score is in the MISSING range
 * but whose confidence is too low for MISSING. The state stays PARTIAL; only how
 * far candidates are looked up changes. Tuned from repeated live runs.
 */
export const CONTEXT_EXPLORATION_LIMITS = {
  /** From this confidence up to `minConfidence`, a MISSING-range score still takes the limited second hop. */
  lowConfidenceMissingMinConfidence: 0.5,
  /**
   * Legacy field retained for the exploration contract. Conditional paths use
   * the same score-dependent VISIBLE policy as ordinary answers.
   */
  conditionalResolutionMinConfidence: 0,
} as const;

/** Contexts the low-confidence policy applies to; TRIGGER and TARGET keep the plain PARTIAL handling. */
export const LOW_CONFIDENCE_MISSING_CONTEXTS: readonly ContextCode[] = ['INPUT', 'LINK', 'ACTION'];

/**
 * How an unresolved context is explored. `MISSING` and `PARTIAL` follow the
 * state. `LOW_CONFIDENCE_MISSING`: PARTIAL state, MISSING-range score and
 * confidence from `lowConfidenceMissingMinConfidence` up to `minConfidence`;
 * takes the same limited second hop as MISSING. `VERY_LOW_CONFIDENCE`: below
 * that confidence; first hop only and always reported in `missingData`.
 */
export type ExplorationClass = 'MISSING' | 'LOW_CONFIDENCE_MISSING' | 'VERY_LOW_CONFIDENCE' | 'PARTIAL';

const SUPPORTED_CODE_FILE = /\.(?:[cm]?js|jsx|tsx?)$/iu;
/** package.json is asked as the lifecycle path; it has no same-file code to expand into. */
export const isLifecycleManifest = (filePath: string): boolean => /(?:^|\/)package\.json$/u.test(filePath);
/** Files whose Findings can be asked: code the expansion parser handles, and the lifecycle manifest. */
/** Type declarations hold no code that runs. */
const DECLARATION_FILE = /\.d\.[cm]?ts$/iu;
export const isSupportedFile = (filePath: string): boolean => (SUPPORTED_CODE_FILE.test(filePath) && !DECLARATION_FILE.test(filePath)) || isLifecycleManifest(filePath);

export const CONTEXT_TARGET_ID_PREFIX = 'context-target-';
export const questionKey = (groupId: string, context: ContextCode): string => `${groupId}__${context}`;
export const artifactFileKey = (artifactId: string, filePath: string): string => `${artifactId}\u0000${filePath}`;
