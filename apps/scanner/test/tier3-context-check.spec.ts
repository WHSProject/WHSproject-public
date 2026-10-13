import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadLlmAgentEnvironment } from '../src/config/scanner-environment';
import type { AnalysisContext } from '../src/domain/analysis.types';
import type { AgentAnalysisResultV0_3, LlmAgentRunnerService } from '../src/llm-agent/agent-runner.service';
import type { AgentAnalysisInputV0_3, Tier3ExecutionInput } from '../src/llm-agent/artifact/agent-analysis-input.contract';
import { AgentInputV0_3Builder, toPackageContextV0_3, type AgentInputV0_3Policy } from '../src/llm-agent/artifact/agent-input-v0_3.builder';
import type { SliceSupplementBudget } from '../src/llm-agent/artifact/artifact-code-slice.builder';
import { RuntimeCodeTool } from '../src/llm-agent/artifact/runtime-code-tool';
import type { AgentCodeSlice } from '../src/llm-agent/artifact/artifact.contract';
import type { Tier2Handoff } from '../src/llm-agent/artifact/tier2-handoff.contract';
import { executeTier3Shadow, executeTier3V0_3 } from '../src/llm-agent/artifact/tier3-runtime';
import type { StaticFilterReasonCode, StaticFilterResult, StaticFilterRuleDiagnostic } from '../src/application/planning/static-filter.types';
import { OBFUSCATION_RULE_IDS } from '../src/analyzers/obfuscation/obfuscation.findings';
import { P0_RULE_IDS } from '../src/analyzers/custom-rule/custom-rule-p0-static';
import {
  BASE_CONTEXTS, MATCH_CLASSIFIED_RULES, PRESERVED_REASONS, REASON_BY_RULE, REASON_CONTEXTS, RULES_BY_BEHAVIOR,
  behaviorGroupForRule, groupPriority, isAskedBehavior, resolveActiveContexts, restorationStatusForRule,
} from '../src/llm-agent/context-check/behavior-groups';
import { validateExpansionCandidates, type CandidateValidationResult } from '../src/llm-agent/context-check/candidate-validation';
import { selectWitnessPaths, type PathRequest } from '../src/llm-agent/context-check/witness-selection';
import { recheckTargets, runRecheck } from '../src/llm-agent/context-check/recheck';
import {
  BEHAVIOR_GROUPS,
  CONTEXT_CHECK_LIMITS,
  questionKey,
  type FindingGroup,
  type GroupExecutionEvidence,
  type LifecycleTriggerQuestion,
  type TriggerEvidenceMode,
  CONTEXT_CODES,
  ContextCheckProviderError,
  isSupportedFile,
  type AskedBehaviorGroup,
  type BehaviorGroup,
  type ContextCheckProvider,
  type ContextCheckRequest,
  type CandidateTraceEntry,
  type ContextCode,
  type ContextWitnessPath,
  type ExpansionCandidate,
  type ScoreAnswer,
} from '../src/llm-agent/context-check/context-check.contract';
import {
  acceptedCandidateRanges, expansionLineBudget, groupsWithUnresolvedTrigger, groupsWithWitnessedInput, groupsWithWitnessedTrigger, runContextCheck as runContextCheckWithDefaults, summarizeContextCheck,
  type ContextCheckInput,
} from '../src/llm-agent/context-check/context-check.service';
import { CANDIDATE_TRACE_RELATIVE_PATH, formatCandidateTrace } from '../src/llm-agent/context-check/candidate-trace';
import {
  buildContextCheckRequest, buildFindingGroups, contextState, explorationClass, planFindingGroups, witnessAwareContextState,
} from '../src/llm-agent/context-check/context-questions';
import {
  CONTEXT_GUIDANCE, QUESTION_PREAMBLE, QUESTION_TEMPLATES, RULES_REFERENCE, groupEvaluationGuidance,
} from '../src/llm-agent/context-check/question-templates';
import { createParseCache, executionPathTo, findingStatement, runsAtLoad, weakestPosition, type ExecutionStep } from '../src/llm-agent/context-check/code-units';
import { executionPathCandidates } from '../src/llm-agent/context-check/execution-evidence';
import {
  analyzeFileLinks, candidateKey, entryPointsAt, generateExpansionCandidates, lifecycleScriptFiles, lifecycleScriptsRunning,
} from '../src/llm-agent/context-check/expansion-candidates';
import { JevProviderClient } from '../src/llm-agent/context-check/jev-provider.client';
import * as programIndexModule from '../src/llm-agent/context-check/program-index/program-index';
import { LlmEvidenceAdapter } from '../src/llm-agent/llm-evidence.adapter';
import { projectPackageContext } from '../src/llm-agent/llm-agent-input-builder.service';
import { StaticArtifactResolver } from './fixtures/tier3-artifacts/mock-artifacts';

const ROOT = join(__dirname, 'fixtures', 'tier3-context-check');
const ORIGINAL = 'ARTIFACT-ORIGINAL-CC';
const DEOBFUSCATED = 'ARTIFACT-DEOBFUSCATED-CC';
const HASH = 'a'.repeat(64);
const FINDING = 'tier2:network:1';
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'original', 'package.json'), 'utf8')) as Record<string, unknown>;
const LEGACY_PACKAGE_CONTEXT = projectPackageContext(MANIFEST);
const RESTORED_SOURCE = readFileSync(join(ROOT, 'deobfuscated', 'install.js'), 'utf8');

const POLICY: AgentInputV0_3Policy = {
  codeSlices: { maxInitialSlices: 10, maxLinesPerSlice: 120, maxInitialCodeLines: 800, maxTotalCodeLines: 1040, maxFileSizeBytes: 1_048_576 },
  maxToolCalls: 4, maxAdditionalCodeRequests: 2,
};
const INPUT_CONTEXT = { scanId: 'scan-context-check', packageName: 'tier3-context-check-fixture', packageVersion: '1.0.0', archiveSha256: HASH };

function resolver(): StaticArtifactResolver {
  return new StaticArtifactResolver([
    { root: join(ROOT, 'original'), descriptor: { artifactId: ORIGINAL, representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: HASH, lineageStatus: 'DIRECT', producer: 'safe-extract' } },
    {
      root: join(ROOT, 'deobfuscated'),
      descriptor: {
        artifactId: DEOBFUSCATED, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: 'b'.repeat(64),
        derivedFromArtifactId: ORIGINAL, lineageStatus: 'UNMAPPED', producer: 'webcrack+babel',
      },
    },
  ]);
}

/** One network Finding in the restored install.js; the plan slices only `range`. */
function execution(range = { startLine: 18, endLine: 19 }, ruleId = 'custom.network-outbound'): Tier3ExecutionInput {
  return {
    validatedPlan: {
      planId: 'PLAN-CONTEXT-CHECK', shouldExecute: true, analysisMode: 'ORIGINAL_AND_DEOBFUSCATED',
      targets: [{ targetId: 'tier3-target-001', artifactId: DEOBFUSCATED, filePath: 'install.js', preferredRange: range, priority: 'HIGH', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: ['TIER2_FINDING'] }],
      focusBehaviors: ['NETWORK_EGRESS'], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' },
    },
    artifacts: resolver(),
    findings: [{ findingId: FINDING, analyzer: 'custom-rule-deobfuscated', analyzerVersion: '1', ruleId, kind: 'CAPABILITY', description: 'Outbound network request', location: { file: 'install.js', ...range }, rawMatch: null }],
    atomicEvidences: [],
    bindings: { findingBindings: [{ findingId: FINDING, artifactId: DEOBFUSCATED, filePath: 'install.js', ...range }], evidenceBindings: [] },
    packageContext: toPackageContextV0_3(LEGACY_PACKAGE_CONTEXT),
  };
}

const builder = new AgentInputV0_3Builder();
const build = (input: Tier3ExecutionInput, supplement?: SliceSupplementBudget, policy = POLICY) => builder.build(input, INPUT_CONTEXT, { ...policy, supplement });

const VISIBLE: ScoreAnswer = { score: 2, confidence: 1 };
const MISSING: ScoreAnswer = { score: 0, confidence: 1 };

/** Answers every question; `answers` overrides by context code, everything else is VISIBLE. */
function provider(answers: Partial<Record<string, ScoreAnswer>> = {}, fallback: ScoreAnswer = VISIBLE) {
  const check = jest.fn(async (request: ContextCheckRequest) => ({
    model: 'jev-test',
    answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, answers[key.split('__')[1] ?? ''] ?? fallback])),
    usage: { inputTokens: 100, outputTokens: 10 },
  }));
  return { check } satisfies ContextCheckProvider;
}

/**
 * The suites below check grouping, expansion, budget and wording with every
 * question asked, so they pin `lifecycleTriggerQuestion` to `ASK` unless a test
 * sets it. What is left out by default is covered in 'lifecycle TRIGGER omission'.
 * They also check the file-by-file lookup, which stays as the fallback, so they
 * turn the whole-package index off; 'context check with the program index'
 * covers the default.
 */
const runContextCheck = (input: ContextCheckInput) => runContextCheckWithDefaults({ lifecycleTriggerQuestion: 'ASK', programIndex: false, ...input });

async function check(options: { input?: Tier3ExecutionInput; provider?: ContextCheckProvider; enabled?: boolean; signal?: AbortSignal; staticFilter?: Pick<StaticFilterResult, 'diagnostics'> } = {}) {
  const input = options.input ?? execution();
  const built = await build(input);
  const rebuild = jest.fn(build);
  const outcome = await runContextCheck({
    enabled: options.enabled ?? true, provider: options.provider, execution: input, built, rebuild,
    policy: POLICY.codeSlices, signal: options.signal,
    ...(options.staticFilter === undefined ? {} : { staticFilter: options.staticFilter }),
  });
  return { built, rebuild, outcome };
}

const ANALYZER = 'custom-rule-deobfuscated';
const ENV_FINDING = 'tier2:env:1';
const HOOK_FINDING = 'tier2:hook:1';

/** FINDING is an environment read (SENSITIVE_READ) and HOOK_FINDING a lifecycle hook (LIFECYCLE), both in install.js. */
function twoGroupExecution(): Tier3ExecutionInput {
  const input = execution(undefined, 'threat-runtime-environment-read');
  input.findings[0]!.findingId = ENV_FINDING;
  input.bindings.findingBindings[0]!.findingId = ENV_FINDING;
  input.validatedPlan.targets[0]!.findingRefs = [ENV_FINDING];
  input.findings.push({ ...input.findings[0]!, findingId: HOOK_FINDING, ruleId: 'threat-process-hooks' });
  input.bindings.findingBindings.push({ ...input.bindings.findingBindings[0]!, findingId: HOOK_FINDING });
  return input;
}

/** A static-filter diagnostic referencing the given Findings of ANALYZER. */
function diagnostic(ruleId: StaticFilterRuleDiagnostic['ruleId'], findingIds: string[], overrides: Partial<StaticFilterRuleDiagnostic> = {}): StaticFilterRuleDiagnostic {
  return {
    ruleId, category: ruleId.startsWith('A') ? 'AMBIGUOUS' : ruleId.startsWith('I') ? 'INCOMPLETE' : 'MALICIOUS', outcome: 'UNVERIFIED',
    conditions: [], linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
    findingRefs: findingIds.map((findingId) => ({ analyzer: ANALYZER, findingId })), evidenceRefs: [], blockingConditions: [],
    ...overrides,
  };
}

const SENSITIVE_READ_BASE = ['TRIGGER', 'ACTION', 'TARGET', 'LINK'];
const LIFECYCLE_BASE = ['TRIGGER', 'ACTION', 'LINK'];

/** Active contexts of the SENSITIVE_READ group (ENV_FINDING) and the LIFECYCLE group (HOOK_FINDING). */
async function groupContexts(diagnostics?: StaticFilterRuleDiagnostic[]) {
  const input = twoGroupExecution();
  const slices = (await build(input)).input.initialCodeSlices;
  const groups = buildFindingGroups(input, slices, diagnostics);
  return {
    read: groups.find((group) => group.behavior === 'SENSITIVE_READ')!.contexts,
    lifecycle: groups.find((group) => group.behavior === 'LIFECYCLE')!.contexts,
  };
}

describe('context check behavior groups', () => {
  it('classifies rule IDs and falls back to OTHER', () => {
    expect(behaviorGroupForRule('threat-network-exfiltration')).toBe('NETWORK_SEND');
    expect(behaviorGroupForRule('threat-network-exfil-sysinfo')).toBe('COLLECT_AND_SEND');
    expect(behaviorGroupForRule('threat-runtime-environment-read')).toBe('SENSITIVE_READ');
    expect(behaviorGroupForRule('threat-process-download-exec')).toBe('DOWNLOAD_AND_EXECUTE');
    expect(behaviorGroupForRule('threat-network-reverse-shell')).toBe('REMOTE_SHELL');
    expect(behaviorGroupForRule('metadata.lifecycle.postinstall')).toBe('LIFECYCLE');
    expect(behaviorGroupForRule('threat-runtime-obfuscation-general')).toBe('OBFUSCATION_SIGNAL');
    expect(behaviorGroupForRule('threat-runtime-obfuscation-base64exec')).toBe('DYNAMIC_CODE');
    expect(behaviorGroupForRule('metadata.license.mismatch')).toBe('PACKAGE_RISK');
    expect(behaviorGroupForRule('some-new-rule')).toBe('OTHER');
    expect(behaviorGroupForRule('')).toBe('OTHER');
  });

  it('groups Findings by file and behavior, and skips files without a slice', async () => {
    const input = execution();
    input.findings.push(
      { ...input.findings[0]!, findingId: 'tier2:network:2', ruleId: 'capability-network-outbound' },
      { ...input.findings[0]!, findingId: 'tier2:env:1', ruleId: 'threat-runtime-environment-read' },
      { ...input.findings[0]!, findingId: 'tier1:unsliced:1', ruleId: 'capability-process-spawn' },
    );
    input.bindings.findingBindings.push(
      { findingId: 'tier2:network:2', artifactId: DEOBFUSCATED, filePath: 'install.js', startLine: 19, endLine: 19 },
      { findingId: 'tier2:env:1', artifactId: DEOBFUSCATED, filePath: 'install.js', startLine: 18, endLine: 18 },
      { findingId: 'tier1:unsliced:1', artifactId: ORIGINAL, filePath: 'lib/collect.js', startLine: 5, endLine: 5 },
    );
    const groups = buildFindingGroups(input, (await build(execution())).input.initialCodeSlices);
    // The threat group is asked before the capability group.
    expect(groups.map(({ groupId, behavior, findingIds, priority }) => ({ groupId, behavior, findingIds, priority }))).toEqual([
      { groupId: 'G1', behavior: 'SENSITIVE_READ', findingIds: ['tier2:env:1'], priority: 2 },
      { groupId: 'G2', behavior: 'NETWORK_SEND', findingIds: [FINDING, 'tier2:network:2'], priority: 4 },
    ]);
    expect(groups[0]!.contexts).toEqual(['TRIGGER', 'ACTION', 'TARGET', 'LINK']);
    expect(groups[1]!.contexts).toEqual([...CONTEXT_CODES]);
  });

  it('asks the base contexts of a behavior group when no static-filter reason is given', () => {
    expect(resolveActiveContexts('NETWORK_SEND')).toEqual([...CONTEXT_CODES]);
    expect(resolveActiveContexts('SENSITIVE_READ')).toEqual(['TRIGGER', 'ACTION', 'TARGET', 'LINK']);
    expect(resolveActiveContexts('PROCESS_EXEC')).toEqual([...CONTEXT_CODES]);
    expect(resolveActiveContexts('LIFECYCLE')).toEqual(['TRIGGER', 'ACTION', 'LINK']);
    expect(resolveActiveContexts('OTHER')).toEqual([...CONTEXT_CODES]);
    expect(resolveActiveContexts('LIFECYCLE', [])).toEqual([...BASE_CONTEXTS.LIFECYCLE]);
  });

  it('adds the contexts a static-filter reason requires, in context order and without duplicates', () => {
    expect(resolveActiveContexts('SENSITIVE_READ', ['BEHAVIOR_LINK_UNVERIFIED'])).toEqual([...CONTEXT_CODES]);
    expect(resolveActiveContexts('LIFECYCLE', ['PAYLOAD_CONTENT_UNVERIFIED'])).toEqual(['TRIGGER', 'ACTION', 'TARGET', 'LINK']);
    expect(resolveActiveContexts('LIFECYCLE', ['BEHAVIOR_LINK_UNVERIFIED', 'PAYLOAD_CONTENT_UNVERIFIED', 'BEHAVIOR_LINK_UNVERIFIED'])).toEqual([...CONTEXT_CODES]);
    expect(resolveActiveContexts('LIFECYCLE', ['EVIDENCE_CONTEXT_MISSING'])).toEqual(['TRIGGER', 'ACTION', 'TARGET', 'LINK']);
    // A reason never removes a base context.
    expect(resolveActiveContexts('NETWORK_SEND', ['RELATION_CANDIDATE_UNVERIFIED'])).toEqual([...CONTEXT_CODES]);
  });

  it('keeps the base contexts for reasons that more code cannot settle', () => {
    const unsettled: StaticFilterReasonCode[] = [
      'ANALYZER_INCOMPLETE', 'ANALYZER_SCOPE_RELEVANCE_UNKNOWN', 'DUAL_USE_CONTEXT_UNRESOLVED', 'NORMALIZATION_GAP', 'RESTORATION_INCOMPLETE',
      'RESTORATION_BUDGET_EXCEEDED', 'PROVENANCE_INCOMPLETE', 'SCAN_COVERAGE_UNKNOWN', 'OBFUSCATION_UNRESOLVED',
      'REPRESENTATION_CONFLICT_UNVERIFIABLE', 'UNCLASSIFIED_THREAT_REVIEW_REQUIRED', 'MALICIOUS_RULE_SATISFIED', 'REQUIRED_RULE_HITS_PRESENT',
      'NO_THREAT_FINDING',
    ];
    expect(resolveActiveContexts('LIFECYCLE', unsettled)).toEqual([...BASE_CONTEXTS.LIFECYCLE]);
    expect(resolveActiveContexts('SENSITIVE_READ', unsettled)).toEqual([...BASE_CONTEXTS.SENSITIVE_READ]);
  });

  it('maps every rule whose diagnostics reference Findings to the reason the static filter derives for it', () => {
    expect(REASON_BY_RULE).toEqual({
      A01: 'OBFUSCATION_UNRESOLVED', A02: 'BEHAVIOR_LINK_UNVERIFIED', A03: 'BEHAVIOR_LINK_UNVERIFIED', A04: 'PAYLOAD_CONTENT_UNVERIFIED',
      A05: 'LIFECYCLE_LINK_UNVERIFIED', A06: 'BEHAVIOR_LINK_UNVERIFIED', A07: 'DUAL_USE_CONTEXT_UNRESOLVED', A08: 'PROPAGATION_LINK_UNVERIFIED',
      A09: 'RELATION_CANDIDATE_UNVERIFIED', I01: 'ANALYZER_INCOMPLETE', I02: 'EVIDENCE_CONTEXT_MISSING', I04: 'RESTORATION_INCOMPLETE',
      I05: 'RESTORATION_BUDGET_EXCEEDED', I06: 'PROVENANCE_INCOMPLETE',
    });
    // Every mapped reason either adds contexts or is preserved, never both and never neither.
    for (const reason of new Set(Object.values(REASON_BY_RULE))) {
      expect(Number(REASON_CONTEXTS[reason] !== undefined) + Number(PRESERVED_REASONS.includes(reason))).toBe(1);
    }
    expect(REASON_CONTEXTS.DUAL_USE_CONTEXT_UNRESOLVED).toBeUndefined();
  });
});

describe('context check active contexts per Finding group', () => {
  it('uses only the base contexts without a static-filter result', async () => {
    expect(await groupContexts()).toEqual({ read: SENSITIVE_READ_BASE, lifecycle: LIFECYCLE_BASE });
    expect(await groupContexts([])).toEqual({ read: SENSITIVE_READ_BASE, lifecycle: LIFECYCLE_BASE });
  });

  it('adds a reason only to the group that holds its Finding', async () => {
    // A03 (BEHAVIOR_LINK_UNVERIFIED -> INPUT, LINK) references the environment read only.
    expect(await groupContexts([diagnostic('A03', [ENV_FINDING])])).toEqual({ read: [...CONTEXT_CODES], lifecycle: LIFECYCLE_BASE });
    // A04 (PAYLOAD_CONTENT_UNVERIFIED -> TARGET, LINK) references the lifecycle hook only.
    expect(await groupContexts([diagnostic('A04', [HOOK_FINDING])])).toEqual({ read: SENSITIVE_READ_BASE, lifecycle: ['TRIGGER', 'ACTION', 'TARGET', 'LINK'] });
  });

  it('applies one reason to every group whose Findings it references', async () => {
    expect(await groupContexts([diagnostic('A03', [ENV_FINDING, HOOK_FINDING])])).toEqual({
      read: [...CONTEXT_CODES], lifecycle: ['TRIGGER', 'INPUT', 'ACTION', 'LINK'],
    });
  });

  it('does not spread a reason whose Findings are missing or unmatched', async () => {
    const base = { read: SENSITIVE_READ_BASE, lifecycle: LIFECYCLE_BASE };
    expect(await groupContexts([diagnostic('A03', [])])).toEqual(base);
    expect(await groupContexts([diagnostic('A03', ['tier2:unknown:9'])])).toEqual(base);
    // Same Finding ID reported by another analyzer is a different Finding.
    expect(await groupContexts([diagnostic('A03', [], { findingRefs: [{ analyzer: 'guarddog', findingId: ENV_FINDING }] })])).toEqual(base);
  });

  it('ignores rules that did not apply and rules whose reason more code cannot settle', async () => {
    const base = { read: SENSITIVE_READ_BASE, lifecycle: LIFECYCLE_BASE };
    expect(await groupContexts([diagnostic('A03', [ENV_FINDING, HOOK_FINDING], { outcome: 'NOT_APPLICABLE' })])).toEqual(base);
    expect(await groupContexts([
      diagnostic('A01', [ENV_FINDING, HOOK_FINDING]), diagnostic('I04', [ENV_FINDING, HOOK_FINDING]), diagnostic('I08', [ENV_FINDING, HOOK_FINDING]),
      diagnostic('M04', [ENV_FINDING, HOOK_FINDING]),
    ])).toEqual(base);
  });

  it('keeps each context once when the base set and several reasons name it', async () => {
    // A05 (TRIGGER, LINK) names contexts the LIFECYCLE base already has; A02 and A03 share one reason.
    expect(await groupContexts([
      diagnostic('A05', [HOOK_FINDING]), diagnostic('A02', [ENV_FINDING]), diagnostic('A03', [ENV_FINDING]), diagnostic('A09', [ENV_FINDING]),
    ])).toEqual({ read: [...CONTEXT_CODES], lifecycle: LIFECYCLE_BASE });
  });
});

describe('context check questions and states', () => {
  it('asks one Score question per active context without Scanner-internal paths', async () => {
    const input = execution();
    const slices = (await build(input)).input.initialCodeSlices;
    const request = buildContextCheckRequest(input, slices, buildFindingGroups(input, slices));
    expect(Object.keys(request.questions)).toEqual(CONTEXT_CODES.map((code) => `G1__${code}`));
    expect(request.questions.G1__LINK).toMatchObject({ type: 'score' });
    expect(request.questions.G1__LINK!.criteria).toHaveLength(3);
    expect(request.questions.G1__LINK!.instructions).toContain('`groups[0]`');
    const serialized = JSON.stringify(request);
    expect(serialized).toContain('request.write(encode(payload));');
    expect(serialized).toContain('node install.js');
    expect((request.state as { groups: unknown[] }).groups[0]).toMatchObject({ filePath: 'install.js', runByLifecycle: ['postinstall'] });
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain(JSON.stringify(ROOT).slice(1, -1));
  });

  it('maps score to a state and applies the score-dependent VISIBLE confidence floor', () => {
    expect(contextState({ score: 2, confidence: 0.9 })).toBe('VISIBLE');
    expect(contextState({ score: 1.2, confidence: 0.3 })).toBe('VISIBLE');
    expect(contextState({ score: 1.2, confidence: 0.29 })).toBe('PARTIAL');
    expect(contextState({ score: 1.49, confidence: 0.29 })).toBe('PARTIAL');
    expect(contextState({ score: 1.5, confidence: 0.2 })).toBe('VISIBLE');
    expect(contextState({ score: 1.5, confidence: 0.19 })).toBe('PARTIAL');
    expect(contextState({ score: 1.19, confidence: 1 })).toBe('PARTIAL');
    expect(contextState({ score: 0.5, confidence: 1 })).toBe('PARTIAL');
    expect(contextState({ score: 0.49, confidence: 1 })).toBe('MISSING');
    expect(contextState({ score: 2, confidence: 0.1 })).toBe('PARTIAL');
    expect(contextState({ score: 1.2, confidence: 0 })).toBe('PARTIAL');
    expect(contextState({ score: 0, confidence: 0.1 })).toBe('MISSING');
  });

  it('applies confidence only to a complete witness with PROBABLE edges', () => {
    expect(witnessAwareContextState({ score: 1.2, confidence: 0 }, 'CONFIRMED')).toBe('VISIBLE');
    expect(witnessAwareContextState({ score: 2, confidence: 0 }, 'CONFIRMED')).toBe('VISIBLE');
    expect(witnessAwareContextState({ score: 1.2, confidence: 0.29 }, 'PROBABLE')).toBe('PARTIAL');
    expect(witnessAwareContextState({ score: 1.2, confidence: 0.3 }, 'PROBABLE')).toBe('VISIBLE');
    expect(witnessAwareContextState({ score: 1.5, confidence: 0.19 }, 'PROBABLE')).toBe('PARTIAL');
    expect(witnessAwareContextState({ score: 1.5, confidence: 0.2 }, 'PROBABLE')).toBe('VISIBLE');
    expect(witnessAwareContextState({ score: 2, confidence: 1 }, 'UNRESOLVED')).toBe('PARTIAL');
    expect(witnessAwareContextState({ score: 0, confidence: 1 }, 'CONFIRMED')).toBe('MISSING');
  });
});

describe('context check expansion candidates', () => {
  it('finds one-hop definitions, assignments, local functions and static relative imports', () => {
    const links = analyzeFileLinks(RESTORED_SOURCE, [{ startLine: 18, endLine: 19 }]);
    // Nearest to the covered lines first: the assignment, then the declarations.
    expect(links.definitions.map((range) => range.startLine)).toEqual([16, 6, 5, 2]);
    // `unused` is not referenced by the covered lines and `collect()` is two hops away.
    expect(links.functions).toEqual([{ startLine: 8, endLine: 10, symbol: 'encode' }]);
    // The file imports ./lib/collect, but lines 18-19 do not use it.
    expect(links.imports).toEqual(['./lib/collect']);
    expect(links.usedImports).toEqual([]);
  });

  it('parses a file once per parse cache and gives the same links with or without it', () => {
    const cache = createParseCache();
    const first = cache.get(RESTORED_SOURCE);
    expect(first).toBeDefined();
    expect(cache.get(RESTORED_SOURCE)).toBe(first);
    expect(createParseCache().get(RESTORED_SOURCE)).not.toBe(first);
    const covered = [{ startLine: 18, endLine: 19 }];
    expect(analyzeFileLinks(RESTORED_SOURCE, covered, cache)).toEqual(analyzeFileLinks(RESTORED_SOURCE, covered));
  });

  it('ignores dynamic and non-relative require calls', () => {
    const code = ['const name = "./a";', 'const a = require(name);', 'const fs = require("fs");', 'const b = require(`./b`);', 'use(a, fs, b);'].join('\n');
    expect(analyzeFileLinks(code, [{ startLine: 5, endLine: 5 }]).imports).toEqual([]);
  });

  it('keeps only pattern-matched imports when the file does not parse', () => {
    const code = ['const a = require("./a");', 'import b from "../b.js";', 'use(a, b);', 'function ( {'].join('\n');
    expect(analyzeFileLinks(code, [{ startLine: 3, endLine: 3 }])).toEqual({ definitions: [], functions: [], imports: ['./a', '../b.js'], usedImports: [], parsed: false });
  });

  it('names the entry points that are a file, with or without its extension', () => {
    const entries = { entryPoints: [{ type: 'MAIN' as const, value: './lib/index', location: null }, { type: 'BIN' as const, value: 'cli.js', location: null }] };
    expect(entryPointsAt(entries, 'lib/index.js')).toEqual(['MAIN']);
    expect(entryPointsAt(entries, 'cli.js')).toEqual(['BIN']);
    expect(entryPointsAt(entries, 'lib/other.js')).toEqual([]);
  });

  it('names the lifecycle scripts that run a file directly', () => {
    const scripts = {
      lifecycleScripts: [
        { name: 'preinstall' as const, command: 'node ./install.js', location: null },
        { name: 'postinstall' as const, command: 'node lib/install.js && node setup.js', location: null },
      ],
    };
    expect(lifecycleScriptsRunning(scripts, 'install.js')).toEqual(['preinstall']);
    expect(lifecycleScriptsRunning(scripts, 'lib/install.js')).toEqual(['postinstall']);
    expect(lifecycleScriptsRunning(scripts, 'other.js')).toEqual([]);
  });

  it('leaves runByLifecycle out for a file no lifecycle script runs', async () => {
    const input = execution();
    input.packageContext = { ...input.packageContext, lifecycleScripts: [] };
    const slices = (await build(input)).input.initialCodeSlices;
    const request = buildContextCheckRequest(input, slices, buildFindingGroups(input, slices));
    expect((request.state as { groups: unknown[] }).groups[0]).not.toHaveProperty('runByLifecycle');
  });

  it('reads the script files a lifecycle command names', () => {
    expect(lifecycleScriptFiles('node install.js')).toEqual(['install.js']);
    expect(lifecycleScriptFiles('node ./scripts/setup.cjs && echo done')).toEqual(['./scripts/setup.cjs']);
    expect(lifecycleScriptFiles('node -e "console.log(1)"')).toEqual([]);
  });

  it('offers used definitions, lifecycle and entry files and local functions, falling back to the ORIGINAL artifact', async () => {
    const input = execution();
    const slices = (await build(input)).input.initialCodeSlices;
    const [group] = buildFindingGroups(input, slices);
    const candidates = await generateExpansionCandidates({
      unresolved: [
        { group: group!, context: 'TRIGGER', state: 'PARTIAL' },
        { group: group!, context: 'INPUT', state: 'MISSING' },
        { group: group!, context: 'ACTION', state: 'PARTIAL' },
      ],
      slices, resolver: input.artifacts, packageContext: input.packageContext, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
    });
    const summary = candidates.map(({ context, kind, artifactId, filePath, startLine, endLine }) => `${context} ${kind} ${artifactId === ORIGINAL ? 'ORIGINAL' : 'DEOBFUSCATED'} ${filePath}:${startLine}-${endLine}`);
    expect(summary).toEqual([
      // MISSING contexts come first.
      'INPUT SAME_FILE_DEFINITION DEOBFUSCATED install.js:16-16',
      'INPUT SAME_FILE_DEFINITION DEOBFUSCATED install.js:6-6',
      'INPUT SAME_FILE_DEFINITION DEOBFUSCATED install.js:5-5',
      'INPUT SAME_FILE_DEFINITION DEOBFUSCATED install.js:2-2',
      // Lines 18-19 do not use ./lib/collect, so no import is offered at the first hop. MISSING INPUT then follows
      // `payload = collect()` (line 16) to the definition of collect, which exists only in the ORIGINAL artifact.
      'INPUT STATIC_IMPORT ORIGINAL lib/collect.js:4-8',
      // What install.js runs at load time and the declarations it uses (lines 2-20, not the unused function).
      'TRIGGER LIFECYCLE_ENTRY DEOBFUSCATED install.js:2-20',
      // index.js exists only in the ORIGINAL artifact; it runs nothing at load time, so it offers no statements.
      'TRIGGER LIFECYCLE_ENTRY ORIGINAL index.js:1-2',
      'ACTION LOCAL_FUNCTION DEOBFUSCATED install.js:8-10',
    ]);
    expect(candidates.find((candidate) => candidate.filePath === 'index.js')!.units).toEqual([]);
    // postinstall runs install.js itself, so its statements are no TRIGGER evidence.
    expect(candidates.find((candidate) => candidate.context === 'TRIGGER' && candidate.filePath === 'install.js')!.exclusion).toBe('SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE');
    expect(candidates.find((candidate) => candidate.depth === 1 && candidate.symbol === 'payload' && candidate.startLine === 16)).toMatchObject({ inputSource: 'CALL' });
  });
});

describe('context check candidate validation', () => {
  const candidate = (overrides: Partial<ExpansionCandidate>): ExpansionCandidate => ({
    groupId: 'G1', context: 'INPUT', state: 'MISSING', kind: 'SAME_FILE_DEFINITION', depth: 1, artifactId: DEOBFUSCATED, filePath: 'install.js', startLine: 5, endLine: 6,
    statementAligned: true, ...overrides,
    units: overrides.units ?? [{ startLine: overrides.startLine ?? 5, endLine: overrides.endLine ?? 6 }],
  });
  async function validate(candidates: ExpansionCandidate[], overrides: {
    remainingSlices?: number; remainingLines?: number; analysisMode?: Tier3ExecutionInput['validatedPlan']['analysisMode'];
    maxTargets?: number; maxLinesPerCandidate?: number;
  } = {}) {
    const input = execution();
    const slices = (await build(input)).input.initialCodeSlices;
    return validateExpansionCandidates({
      candidates, groups: buildFindingGroups(input, slices), slices, resolver: input.artifacts,
      analysisMode: overrides.analysisMode ?? 'ORIGINAL_AND_DEOBFUSCATED',
      remainingSlices: overrides.remainingSlices ?? CONTEXT_CHECK_LIMITS.maxExpansionTargets, remainingLines: overrides.remainingLines ?? 700,
      ...(overrides.maxTargets === undefined ? {} : { maxTargets: overrides.maxTargets }),
      ...(overrides.maxLinesPerCandidate === undefined ? {} : { maxLinesPerCandidate: overrides.maxLinesPerCandidate }),
      maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
    });
  }

  it('builds Plan targets from new statements and leaves out those already supplied', async () => {
    const result = await validate([
      candidate({ units: [{ startLine: 5, endLine: 5 }, { startLine: 6, endLine: 6 }] }),
      candidate({ startLine: 18, endLine: 19 }),
      candidate({ context: 'LINK', startLine: 6, endLine: 6 }),
      candidate({
        context: 'TRIGGER', kind: 'LIFECYCLE_ENTRY', startLine: 2, endLine: 20,
        units: [{ startLine: 2, endLine: 2 }, { startLine: 3, endLine: 3 }, { startLine: 16, endLine: 16 }, { startLine: 18, endLine: 18, executable: true }, { startLine: 20, endLine: 20, executable: true }],
      }),
    ]);
    expect(result.targets).toEqual([
      {
        targetId: 'context-target-001', artifactId: DEOBFUSCATED, filePath: 'install.js', preferredRange: { startLine: 5, endLine: 6 },
        priority: 'MEDIUM', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: ['CONTEXT_EXPANSION', 'CONTEXT_INPUT', 'SAME_FILE_DEFINITION'],
      },
      // New statements of the lifecycle file: 2-3 and 16 are separated by the accepted 5-6, 20 by the supplied 18-19;
      // the run that runs at load time (line 20) is preferred.
      expect.objectContaining({ targetId: 'context-target-002', preferredRange: { startLine: 20, endLine: 20 } }),
    ]);
    expect(result.trace.map((entry) => entry.exclusionReason)).toEqual([null, 'ALREADY_COVERED', 'DUPLICATE', null]);
    // LINK asked for line 6, which target 001 already serves.
    expect(result.contextsByTarget.get('context-target-001')).toEqual(['G1__INPUT', 'G1__LINK']);
    expect(result.contextsByTarget.get('context-target-002')).toEqual(['G1__TRIGGER']);
  });

  it('applies line, target and representation limits and skips unreadable files', async () => {
    // Whole statements only: the budget takes the statements that fit, never part of one.
    const statements = [2, 3, 5, 6].map((line) => ({ startLine: line, endLine: line }));
    expect((await validate([candidate({ startLine: 2, endLine: 6, units: statements })], { remainingLines: 2 })).targets[0]!.preferredRange).toEqual({ startLine: 2, endLine: 3 });
    expect((await validate([candidate({ startLine: 8, endLine: 10 })], { remainingLines: 2 })).targets).toEqual([]);
    expect((await validate([candidate({})], { remainingSlices: 0 })).targets).toEqual([]);
    expect((await validate([candidate({ artifactId: ORIGINAL, filePath: 'lib/collect.js', startLine: 1, endLine: 8 })], { analysisMode: 'DEOBFUSCATED_ONLY' })).targets).toEqual([]);
    expect((await validate([candidate({ filePath: 'missing.js' }), candidate({ startLine: 99, endLine: 120 })])).targets).toEqual([]);
    // Every line of install.js and three of lib/collect.js are requested one at a time: thirteen of them hold new code,
    // and they stay separate targets up to the target limit.
    const many = [
      ...Array.from({ length: 20 }, (_, index) => candidate({ startLine: index + 1, endLine: index + 1 })),
      ...[4, 5, 8].map((line) => candidate({ artifactId: ORIGINAL, filePath: 'lib/collect.js', startLine: line, endLine: line })),
    ];
    const limited = await validate(many);
    expect(limited.trace.filter((entry) => entry.selected || entry.exclusionReason === 'TARGET_LIMIT')).toHaveLength(13);
    expect(limited.targets).toHaveLength(13);
    expect(CONTEXT_CHECK_LIMITS.maxExpansionTargets).toBe(80);
    expect((await validate(many, { remainingSlices: 5, maxTargets: 5 })).targets).toHaveLength(5);
    // A file is read once however many candidates and validations look at it.
    const sourceCache = new Map<string, { lines: string[]; filePath: string } | null>();
    const cached = await validateExpansionCandidates({ candidates: many, groups: buildFindingGroups(execution(), (await build(execution())).input.initialCodeSlices), slices: (await build(execution())).input.initialCodeSlices, resolver: execution().artifacts, analysisMode: 'ORIGINAL_AND_DEOBFUSCATED', remainingSlices: 40, remainingLines: 480, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes, sourceCache });
    expect(cached.targets).toEqual(limited.targets);
    expect([...sourceCache.keys()]).toHaveLength(2);
    const measured = await validate(many, { remainingSlices: 16, maxTargets: 16 });
    expect(measured.targets).toHaveLength(13);
  });
});

describe('Jev provider client', () => {
  const settings = (overrides: NodeJS.ProcessEnv = {}) => loadLlmAgentEnvironment({ TYPESAFE_API_KEY: 'test-key', ...overrides });
  const request: ContextCheckRequest = { state: { slices: [] }, questions: { G1__LINK: { type: 'score', instructions: 'question', criteria: ['a', 'b', 'c'] } } };
  const response = (body: unknown, status = 200) => jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends one System One request and reads score answers', async () => {
    const fetcher = response({ model: 'jev-1.13.0', answers: { G1__LINK: { type: 'score', score: 1.4, confidence: 0.8, probabilities: {} } }, usage: { input_tokens: 392, output_tokens: 65 } });
    const result = await new JevProviderClient(settings(), fetcher).check(request);
    expect(result).toEqual({ model: 'jev-1.13.0', answers: { G1__LINK: { score: 1.4, confidence: 0.8 } }, usage: { inputTokens: 392, outputTokens: 65 } });
    const [url, init] = (fetcher as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'jev-latest', state: request.state, questions: request.questions });
  });

  it('fails without calling the service when no key is configured', async () => {
    const fetcher = response({});
    await expect(new JevProviderClient(loadLlmAgentEnvironment({}), fetcher).check(request)).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports HTTP, transport and malformed-answer failures as provider errors', async () => {
    await expect(new JevProviderClient(settings(), response({}, 429)).check(request)).rejects.toMatchObject({ reason: 'HTTP' });
    await expect(new JevProviderClient(settings(), response({ answers: {} })).check(request)).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    await expect(new JevProviderClient(settings(), response({ answers: { G1__LINK: { score: 1, confidence: 2 } } })).check(request)).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
    const failing = jest.fn(async () => { throw new Error('socket closed'); }) as unknown as typeof fetch;
    await expect(new JevProviderClient(settings(), failing).check(request)).rejects.toMatchObject({ reason: 'TRANSPORT' });
  });

  it('reports its own deadline as TIMEOUT, separately from caller cancellation and transport errors', async () => {
    const timed = settings({ LLM_AGENT_CONTEXT_CHECK_TIMEOUT_MS: '1' });
    const hanging = jest.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    await expect(new JevProviderClient(timed, hanging).check(request)).rejects.toMatchObject({ reason: 'TIMEOUT' });

    const controller = new AbortController();
    const cancelled = new JevProviderClient(settings(), hanging).check(request, controller.signal);
    controller.abort(new Error('caller cancelled'));
    await expect(cancelled).rejects.toBeInstanceOf(DOMException);
  });
});

describe('context check environment', () => {
  it('is on by default, can be turned off, and never stops the Scanner from starting without a key', () => {
    expect(loadLlmAgentEnvironment({})).toMatchObject({ LLM_AGENT_CONTEXT_CHECK_ENABLED: true, LLM_AGENT_CONTEXT_CHECK_MODEL: 'jev-latest', TYPESAFE_BASE_URL: 'https://api.typesafe.ai' });
    expect(loadLlmAgentEnvironment({ LLM_AGENT_CONTEXT_CHECK_ENABLED: 'false' })).toMatchObject({ LLM_AGENT_CONTEXT_CHECK_ENABLED: false });
    expect(loadLlmAgentEnvironment({})).toMatchObject({ LLM_AGENT_CONTEXT_RECHECK_ENABLED: false, LLM_AGENT_MAX_TOTAL_CODE_LINES: 1600 });
    expect(loadLlmAgentEnvironment({ LLM_AGENT_CONTEXT_RECHECK_ENABLED: 'true' })).toMatchObject({ LLM_AGENT_CONTEXT_RECHECK_ENABLED: true });
    const active = { LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' };
    // An environment that runs Tier 3 without a TypeSafe key still loads; the check itself reports NOT_CONFIGURED.
    expect(() => loadLlmAgentEnvironment(active)).not.toThrow();
    expect(() => loadLlmAgentEnvironment({ ...active, TYPESAFE_API_KEY: 'test-key' })).not.toThrow();
  });

  it('skips the check and keeps the input as built when no key is configured', async () => {
    const settings = loadLlmAgentEnvironment({ LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' });
    const fetcher = jest.fn();
    const input = execution();
    const built = await build(input);
    const outcome = await runContextCheckWithDefaults({
      enabled: settings.LLM_AGENT_CONTEXT_CHECK_ENABLED, provider: new JevProviderClient(settings, fetcher as unknown as typeof fetch),
      execution: input, built, rebuild: build, policy: POLICY.codeSlices,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(outcome.built).toBe(built);
    expect(outcome.record).toMatchObject({ status: 'UNAVAILABLE', failureReason: 'NOT_CONFIGURED' });
  });
});

describe('runContextCheck', () => {
  it('returns the built input untouched when disabled or without a provider', async () => {
    const jev = provider();
    const disabled = await check({ provider: jev, enabled: false });
    expect(disabled.outcome.built).toBe(disabled.built);
    expect(disabled.outcome.record.status).toBe('DISABLED');
    expect(jev.check).not.toHaveBeenCalled();
    expect((await check({})).outcome.record.status).toBe('DISABLED');
  });

  it('keeps the slices when every context is visible', async () => {
    const jev = provider();
    const { built, rebuild, outcome } = await check({ provider: jev });
    expect(jev.check).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(outcome.built).toBe(built);
    expect(outcome.record).toMatchObject({ status: 'SUFFICIENT', groupCount: 1, addedSliceCount: 0, unresolvedContextCount: 0, model: 'jev-test' });
    expect(outcome.record.states).toHaveLength(CONTEXT_CODES.length);
  });

  it('adds directly linked code as INITIAL slices through appended Plan targets, once', async () => {
    const jev = provider({}, MISSING);
    const original = execution();
    const { built, rebuild, outcome } = await check({ input: original, provider: jev });
    expect(jev.check).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
    // Targets are appended to a copy; the plan handed in is not modified.
    expect(original.validatedPlan.targets.map((target) => target.targetId)).toEqual(['tier3-target-001']);

    const { input } = outcome.built;
    // The original target and its slice are unchanged; expansion targets follow it.
    expect(input.analysisPlan.targets.map((target) => target.targetId)).toEqual([
      'tier3-target-001', 'context-target-001', 'context-target-002', 'context-target-003', 'context-target-004', 'context-target-005', 'context-target-006', 'context-target-007',
    ]);
    expect(input.initialCodeSlices[0]).toEqual(built.input.initialCodeSlices[0]);
    const added = input.initialCodeSlices.slice(1);
    // INPUT: the value statements, then (second hop) the definition of collect; ACTION: the local function.
    // TRIGGER gets nothing: postinstall runs install.js itself.
    expect(added.map((slice) => `${slice.artifactId === ORIGINAL ? 'ORIGINAL' : 'DEOBFUSCATED'} ${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual([
      'DEOBFUSCATED install.js:16-16', 'DEOBFUSCATED install.js:6-6', 'DEOBFUSCATED install.js:5-5', 'DEOBFUSCATED install.js:2-2',
      'DEOBFUSCATED install.js:8-10', 'ORIGINAL lib/collect.js:4-8', 'DEOBFUSCATED install.js:3-3',
    ]);
    for (const slice of added) {
      expect(slice).toMatchObject({ origin: 'INITIAL', additionalCodeRequestId: null, relatedFindingIds: [FINDING] });
      expect(slice.planningTargetId).toMatch(/^context-target-/u);
    }
    // Only TRIGGER has no evidence, and it stays missing; INPUT is resolved because collect's definition is shown.
    // The note says what is known: postinstall runs install.js itself.
    expect(input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: 'install.js (NETWORK_SEND): TRIGGER context is MISSING in the supplied slices; the postinstall script runs this file directly; the flagged code runs when the file is loaded; no other caller or entry point was found.' },
    ]);
    expect(outcome.record).toMatchObject({ status: 'EXPANDED', addedTargetCount: 7, addedSliceCount: 7, addedLineCount: 13, unresolvedContextCount: 1 });
  });

  it('expands only for the contexts that are not visible', async () => {
    const { outcome } = await check({ provider: provider({ ACTION: MISSING }) });
    const added = outcome.built.input.initialCodeSlices.slice(1);
    expect(added.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual(['install.js:8-10']);
    expect(outcome.built.input.analysisPlan.targets[1]!.reasonCodes).toEqual(['CONTEXT_EXPANSION', 'CONTEXT_ACTION', 'LOCAL_FUNCTION']);
  });

  it('records a context without a candidate as missingData', async () => {
    // lib/collect.js is sliced whole and imports nothing, so ACTION has nothing to add.
    const input = execution({ startLine: 1, endLine: 8 });
    input.validatedPlan.targets[0] = { ...input.validatedPlan.targets[0]!, artifactId: ORIGINAL, filePath: 'lib/collect.js' };
    input.bindings.findingBindings[0] = { ...input.bindings.findingBindings[0]!, artifactId: ORIGINAL, filePath: 'lib/collect.js' };
    const { built, rebuild, outcome } = await check({ input, provider: provider({ ACTION: { score: 1, confidence: 1 } }) });
    expect(rebuild).not.toHaveBeenCalled();
    expect(outcome.built.input.initialCodeSlices).toEqual(built.input.initialCodeSlices);
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: 'lib/collect.js (NETWORK_SEND): ACTION context is PARTIAL in the supplied slices and no directly linked code could be added.' },
    ]);
    // No candidate means no rebuild, so none of the expansion budget is used.
    expect(outcome.record).toMatchObject({ status: 'NO_CANDIDATE', unresolvedContextCount: 1, addedSliceCount: 0, addedLineCount: 0 });
  });

  it('asks each group its own active contexts, using the static-filter diagnostics when the caller has them', async () => {
    const asked = async (staticFilter?: Pick<StaticFilterResult, 'diagnostics'>) => {
      const jev = provider();
      await check({ input: twoGroupExecution(), provider: jev, staticFilter });
      return Object.keys(jev.check.mock.calls[0]![0].questions);
    };
    // G1 is the SENSITIVE_READ group, G2 the LIFECYCLE group.
    const base = ['G1__TRIGGER', 'G1__ACTION', 'G1__TARGET', 'G1__LINK', 'G2__TRIGGER', 'G2__ACTION', 'G2__LINK'];
    // Today's caller passes no static-filter result.
    expect(await asked()).toEqual(base);
    expect(await asked({ diagnostics: [] })).toEqual(base);
    expect(await asked({ diagnostics: [diagnostic('A03', [ENV_FINDING])] })).toEqual([
      'G1__TRIGGER', 'G1__INPUT', 'G1__ACTION', 'G1__TARGET', 'G1__LINK', 'G2__TRIGGER', 'G2__ACTION', 'G2__LINK',
    ]);
  });

  it('falls back to the built input when the provider fails', async () => {
    const failing: ContextCheckProvider = { check: jest.fn(async () => { throw new ContextCheckProviderError('HTTP 529', 'HTTP'); }) };
    const { built, outcome } = await check({ provider: failing });
    expect(outcome.built).toBe(built);
    expect(outcome.record).toMatchObject({ status: 'UNAVAILABLE', failureReason: 'HTTP', states: [] });
  });

  it('records an initial provider timeout with its distinct diagnostic count', async () => {
    const failing: ContextCheckProvider = { check: jest.fn(async () => { throw new ContextCheckProviderError('deadline', 'TIMEOUT'); }) };
    const { outcome } = await check({ provider: failing });
    expect(outcome.record).toMatchObject({ status: 'UNAVAILABLE', failureReason: 'TIMEOUT' });
    expect(summarizeContextCheck(outcome.record)).toMatchObject({ failureReason: 'TIMEOUT', providerTimeoutCount: 1 });
  });

  it('skips the provider when the request exceeds the input budget', async () => {
    const input = execution();
    const built = await build(input);
    const [slice] = built.input.initialCodeSlices;
    const oversized = { ...built, input: { ...built.input, initialCodeSlices: [{ ...slice!, content: 'x'.repeat(CONTEXT_CHECK_LIMITS.maxStateChars) }] } };
    const jev = provider({}, MISSING);
    const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built: oversized, rebuild: build, policy: POLICY.codeSlices });
    expect(jev.check).not.toHaveBeenCalled();
    expect(outcome.built.input.initialCodeSlices).toBe(oversized.input.initialCodeSlices);
    expect(outcome.record).toMatchObject({ status: 'INPUT_TOO_LARGE', skippedGroups: [{ filePath: 'install.js', behavior: 'NETWORK_SEND', reason: 'INPUT_LIMIT' }] });
    // The group could not be checked, and Tier 3 is told so.
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: `install.js (NETWORK_SEND): not context-checked; reason=INPUT_LIMIT; findings=${FINDING}` },
    ]);
  });

  it('keeps the built input and reports the contexts when the rebuild fails', async () => {
    const input = execution();
    const built = await build(input);
    const outcome = await runContextCheck({
      enabled: true, provider: provider({}, MISSING), execution: input, built, rebuild: async () => { throw new Error('Invalid Tier 3 input 0.3.0'); },
      policy: POLICY.codeSlices,
    });
    expect(outcome.built.input.initialCodeSlices).toEqual(built.input.initialCodeSlices);
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toHaveLength(CONTEXT_CODES.length);
    expect(outcome.record).toMatchObject({ status: 'EXPANSION_FAILED', unresolvedContextCount: CONTEXT_CODES.length });
  });

  it('propagates an aborted scan instead of hiding it', async () => {
    const controller = new AbortController();
    const aborting: ContextCheckProvider = { check: jest.fn(async () => { controller.abort(); throw new Error('aborted'); }) };
    await expect(check({ provider: aborting, signal: controller.signal })).rejects.toThrow('aborted');
  });
});

describe('context check expansion budget', () => {
  const ARTIFACT = 'ARTIFACT-BUDGET';
  const lineCount = (slices: readonly { startLine: number; endLine: number }[]) => slices.reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0);
  const source = (count: number) => `${Array.from({ length: count }, (_, index) => `const value${index + 1} = ${index + 1};`).join('\n')}\n`;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'context-check-budget-'));
    await writeFile(join(root, 'big.js'), source(1000));
    // Lifecycle and entry files offer what they run at load time, so they hold top-level calls.
    const calls = Array.from({ length: 200 }, (_, index) => `console.log(${index + 1});`);
    for (const file of ['setup.js', 'setup2.js', 'entry.js']) await writeFile(join(root, file), `${calls.join('\n')}\n`);
  });
  afterAll(async () => rm(root, { recursive: true, force: true }));

  /** One Finding in big.js whose plan target asks for lines 1..endLine; three 200-line lifecycle and entry files exist. */
  function bigExecution(endLine: number): Tier3ExecutionInput {
    const command = 'node setup.js && node setup2.js';
    return {
      validatedPlan: {
        planId: 'PLAN-BUDGET', shouldExecute: true, analysisMode: 'ORIGINAL_ONLY',
        targets: [{ targetId: 'tier3-target-001', artifactId: ARTIFACT, filePath: 'big.js', preferredRange: { startLine: 1, endLine }, priority: 'HIGH', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: ['TIER1_FINDING'] }],
        focusBehaviors: ['NETWORK_EGRESS'], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' },
      },
      artifacts: new StaticArtifactResolver([{ root, descriptor: { artifactId: ARTIFACT, representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: HASH, lineageStatus: 'DIRECT', producer: 'safe-extract' } }]),
      findings: [{ findingId: FINDING, analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.network-outbound', kind: 'CAPABILITY', description: 'Outbound network request', location: { file: 'big.js', startLine: 400, endLine: 400 }, rawMatch: null }],
      atomicEvidences: [],
      bindings: { findingBindings: [{ findingId: FINDING, artifactId: ARTIFACT, filePath: 'big.js', startLine: 400, endLine: 400 }], evidenceBindings: [] },
      packageContext: {
        source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', description: null, main: 'entry.js', exports: null, scripts: { postinstall: command }, dependencies: {},
        entryPoints: [{ type: 'MAIN', value: 'entry.js', location: null }], lifecycleScripts: [{ name: 'postinstall', command, location: null }],
      },
    };
  }

  /** TRIGGER is MISSING, so setup.js, setup2.js and entry.js (60 lines each, 180 in total) are the candidates. */
  async function expand(endLine: number, policy = POLICY) {
    const input = bigExecution(endLine);
    const built = await build(input, undefined, policy);
    const rebuild = jest.fn((expanded: Tier3ExecutionInput, supplement: SliceSupplementBudget) => build(expanded, supplement, policy));
    const jev = provider({ TRIGGER: MISSING });
    const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, rebuild, policy: policy.codeSlices });
    const original = outcome.built.input.initialCodeSlices.filter((slice) => slice.planningTargetId === 'tier3-target-001');
    const added = outcome.built.input.initialCodeSlices.filter((slice) => slice.planningTargetId !== 'tier3-target-001');
    return { input, built, rebuild, jev, outcome, original, added };
  }

  it('allows up to 480 lines and always keeps one re-request for Tier 3', () => {
    const { codeSlices } = POLICY;
    expect(expansionLineBudget(codeSlices, 800)).toBe(120);
    expect(expansionLineBudget(codeSlices, 700)).toBe(220);
    expect(expansionLineBudget(codeSlices, 100)).toBe(480);
    expect(expansionLineBudget({ ...codeSlices, maxTotalCodeLines: 1600 }, 800)).toBe(480);
    expect(expansionLineBudget(codeSlices, 801)).toBe(119);
    // Exactly one re-request left in total: all of it stays with Tier 3.
    expect(expansionLineBudget({ ...codeSlices, maxTotalCodeLines: 920 }, 800)).toBe(0);
    expect(expansionLineBudget({ ...codeSlices, maxTotalCodeLines: 900 }, 800)).toBe(-20);
  });

  it('expands by 120 lines when the INITIAL slices already use all 800 lines', async () => {
    // The target asks for 900 lines and is cut at the 800-line INITIAL budget.
    const { built, rebuild, outcome, original, added } = await expand(900);
    expect(lineCount(built.input.initialCodeSlices)).toBe(800);
    expect(rebuild).toHaveBeenCalledWith(expect.anything(), { fromTargetIndex: 1, maxCodeLines: 120, maxSlices: CONTEXT_CHECK_LIMITS.maxExpansionTargets });
    // The truncated target does not grow into the expansion's share.
    expect(original).toEqual(built.input.initialCodeSlices);
    expect(added.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual(['setup.js:1-40', 'setup2.js:1-40', 'entry.js:1-40']);
    expect(lineCount(outcome.built.input.initialCodeSlices)).toBe(920);
    expect(POLICY.codeSlices.maxTotalCodeLines - lineCount(outcome.built.input.initialCodeSlices)).toBe(120);
    // setup.js and setup2.js only log, so they show no path to big.js and TRIGGER stays unresolved.
    expect(outcome.record).toMatchObject({ status: 'EXPANDED', addedTargetCount: 3, addedSliceCount: 3, addedLineCount: 120, unresolvedContextCount: 1 });
  });

  it('never expands beyond what leaves one re-request for Tier 3', async () => {
    const { built, outcome, original, added } = await expand(700);
    expect(lineCount(built.input.initialCodeSlices)).toBe(700);
    expect(original).toEqual(built.input.initialCodeSlices);
    // 220 lines are free once one re-request is set aside for Tier 3.
    expect(lineCount(added)).toBeLessThanOrEqual(220);
    expect(POLICY.codeSlices.maxTotalCodeLines - lineCount(outcome.built.input.initialCodeSlices)).toBeGreaterThanOrEqual(120);
  });

  it('does not expand and reports missingData when no more than one re-request is left in total', async () => {
    const tight = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxTotalCodeLines: 900 } };
    const { built, rebuild, jev, outcome } = await expand(900, tight);
    expect(lineCount(built.input.initialCodeSlices)).toBe(800);
    expect(jev.check).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(outcome.built.input.initialCodeSlices).toEqual(built.input.initialCodeSlices);
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: 'big.js (NETWORK_SEND): TRIGGER context is MISSING in the supplied slices; the flagged code runs when the file is loaded; other callers or entry points were not looked up.' },
    ]);
    expect(outcome.record).toMatchObject({ status: 'NO_BUDGET', addedSliceCount: 0, addedLineCount: 0, unresolvedContextCount: 1 });
  });

  it('says other callers were not looked up when there is no budget and a lifecycle script runs the file', async () => {
    const tight = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxTotalCodeLines: 900 } };
    const input = bigExecution(900);
    input.packageContext = { ...input.packageContext, scripts: { postinstall: 'node big.js' }, lifecycleScripts: [{ name: 'postinstall', command: 'node big.js', location: null }] };
    const built = await build(input, undefined, tight);
    const outcome = await runContextCheck({ enabled: true, provider: provider({ TRIGGER: MISSING }), execution: input, built, rebuild: jest.fn(), policy: tight.codeSlices });
    expect(outcome.record).toMatchObject({ status: 'NO_BUDGET' });
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck').map((item) => item.reason)).toEqual([
      'big.js (NETWORK_SEND): TRIGGER context is MISSING in the supplied slices; the postinstall script runs this file directly; the flagged code runs when the file is loaded; other callers or entry points were not looked up.',
    ]);
  });

  it('leaves the Tier 3 request limits unchanged and one GET_FILE_RANGE request still fits', async () => {
    const { input, built, outcome } = await expand(900);
    expect(outcome.built.input.analysisPolicy).toEqual(built.input.analysisPolicy);
    expect(outcome.built.input.analysisPolicy).toEqual({ maxToolCalls: 4, maxAdditionalCodeRequests: 2, maxTotalCodeLines: 1040 });

    // Same accounting as LlmAgentRunnerService.executeV0_3: usage starts from the registered slices.
    const usage = { calls: 0, additionalCodeRequests: 0, codeLines: lineCount(outcome.built.registry.list()), requestKeys: new Set<string>() };
    const context = {
      resolver: input.artifacts, registry: outcome.built.registry, analysisMode: input.validatedPlan.analysisMode, policy: outcome.built.input.analysisPolicy,
      maxLinesPerRequest: POLICY.codeSlices.maxLinesPerSlice, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes, usage,
    };
    const tool = new RuntimeCodeTool();
    const request = (id: string, startLine: number, endLine: number) => ({ id, type: 'GET_FILE_RANGE' as const, target: { artifactId: ARTIFACT, filePath: 'big.js', startLine, endLine }, reasonCode: 'NEED_DEFINITION' });
    expect(usage.codeLines).toBe(920);
    const served = await tool.getFileRange(request('REQ-1', 801, 920), context);
    if ('unavailable' in served) throw new Error('expected a served slice');
    const { slice } = served;
    expect(slice).toMatchObject({ origin: 'RUNTIME', startLine: 801, endLine: 920 });
    // The expansion did not use up a request: both counters start at zero and only the Agent's request moved them.
    expect(usage).toMatchObject({ calls: 1, additionalCodeRequests: 1, codeLines: 1040 });
    await expect(tool.getFileRange(request('REQ-2', 921, 921), context)).resolves.toMatchObject({ unavailable: { reason: 'BUDGET_EXHAUSTED' } });
    expect(usage).toMatchObject({ calls: 1, additionalCodeRequests: 1, codeLines: 1040 });
  });
});

describe('executeTier3Shadow with the context check', () => {
  const DERIVED_HASH = 'b'.repeat(64);
  const context: AnalysisContext = {
    requestId: 'request-context-check', scanId: 'scan-context-check', package: { name: 'tier3-context-check-fixture', version: '1.0.0' },
    artifact: { tarballPath: 'package.tgz', extractedPath: join(ROOT, 'original'), hash: HASH },
    metadata: { registryMetadata: {}, packageJson: MANIFEST },
  };
  function handoff(): Tier2Handoff {
    const artifactId = `artifact:${HASH}:deobfuscated:${DERIVED_HASH}`;
    const fixture = execution();
    return {
      artifact: {
        artifactId, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: DERIVED_HASH,
        derivedFromArtifactId: `artifact:${HASH}`, lineageStatus: 'UNMAPPED', producer: 'scanner-obfuscation-restore',
      },
      artifactRoot: join(ROOT, 'deobfuscated'),
      findings: fixture.findings, atomicEvidences: [],
      findingBindings: fixture.bindings.findingBindings.map((binding) => ({ ...binding, artifactId })), evidenceBindings: [],
      limitations: [],
    };
  }
  const result: AgentAnalysisResultV0_3 = {
    status: 'COMPLETED', analysisId: 'analysis-context-check', promptVersion: '0.2.0', outputSchemaVersion: '0.2.0',
    providerRequestIds: [], usage: {}, modelCalls: 1, toolCalls: 0, additionalCodeRequests: 0, durationMs: 1, limitations: [], slices: [], codeRequests: [],
  };
  const active = { LLM_AGENT_ENABLED: 'true', LLM_AGENT_TRIGGER_MODE: 'ALWAYS', LLM_AGENT_MODEL: 'test-model', OPENAI_API_KEY: 'test-key' };
  async function run(environment: NodeJS.ProcessEnv, contextCheckProvider?: ContextCheckProvider) {
    const received: AgentAnalysisInputV0_3[] = [];
    const runner = { executeV0_3: jest.fn(async (input: AgentAnalysisInputV0_3) => { received.push(input); return result; }) };
    const shadow = await executeTier3Shadow(context, handoff(), loadLlmAgentEnvironment(environment), {
      inputBuilder: new AgentInputV0_3Builder(), runner: runner as unknown as LlmAgentRunnerService, evidenceAdapter: new LlmEvidenceAdapter(), contextCheckProvider,
    });
    return { shadow, input: received[0]! };
  }

  it('hands the static filter diagnostics of the scan to the context check through executeTier3V0_3', async () => {
    const asked = async (staticFilter?: Pick<StaticFilterResult, 'diagnostics'>) => {
      const jev = provider();
      const operational = await executeTier3V0_3({
        execution: twoGroupExecution(),
        context: { scanId: 'scan-context-check', packageName: 'tier3-context-check-fixture', packageVersion: '1.0.0', archiveSha256: HASH },
        settings: loadLlmAgentEnvironment({ ...active, LLM_AGENT_CONTEXT_CHECK_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }),
        dependencies: { inputBuilder: new AgentInputV0_3Builder(), runner: { executeV0_3: jest.fn(async () => result) } as unknown as LlmAgentRunnerService, evidenceAdapter: new LlmEvidenceAdapter(), contextCheckProvider: jev },
        triggerReason: 'STATIC_FILTER_AMBIGUOUS',
        ...(staticFilter === undefined ? {} : { staticFilter }),
      });
      return { keys: Object.keys(jev.check.mock.calls[0]![0].questions), operational };
    };
    const without = await asked();
    // A03 turns INPUT on for the SENSITIVE_READ group that holds the Finding it names.
    const withReason = await asked({ diagnostics: [diagnostic('A03', [ENV_FINDING])] });
    expect(without.keys).not.toContain('G1__INPUT');
    expect(withReason.keys).toContain('G1__INPUT');
    expect(withReason.operational.contextCheck).toMatchObject({ status: 'EXPANDED', groupCount: 2 });
    expect(summarizeContextCheck(withReason.operational.contextCheck!)).toMatchObject({
      status: 'EXPANDED', groupCount: 2, questionCount: withReason.keys.length, model: 'jev-test',
    });
    // The summary holds counts only: no file paths, findings or code.
    const summary = JSON.stringify(summarizeContextCheck(withReason.operational.contextCheck!));
    expect(summary).not.toContain('install.js');
    expect(summary).not.toContain(ENV_FINDING);
  });

  it('leaves the Agent input and the Shadow result unchanged while the check is off', async () => {
    const jev = provider({}, MISSING);
    const { shadow, input } = await run({ ...active, LLM_AGENT_CONTEXT_CHECK_ENABLED: 'false' }, jev);
    expect(jev.check).not.toHaveBeenCalled();
    expect(input.initialCodeSlices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual(['install.js:18-19']);
    expect(shadow).toMatchObject({ status: 'COMPLETED', initialSliceCount: 1 });
    expect(shadow).not.toHaveProperty('contextCheck');
  });

  it('hands the Agent the supplemented slices and records the check in the Shadow result', async () => {
    const { shadow, input } = await run({ ...active, LLM_AGENT_CONTEXT_CHECK_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }, provider({}, MISSING));
    // The whole-package index is on here, as in a real scan, and every path is added whole. TARGET: where the first
    // argument of https.request comes from (5). INPUT: the value flow of the two Finding statements, which is encode whole
    // (8-10), payload (6, 16), the require of collect (3), its export (lib/collect.js 8) and collect whole (4-6).
    // ACTION adds nothing: the https.request call is in the Finding itself.
    expect(input.initialCodeSlices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual([
      'install.js:18-19', 'install.js:5-5', 'install.js:8-10', 'install.js:6-6', 'install.js:16-16', 'install.js:3-3', 'lib/collect.js:8-8', 'lib/collect.js:4-6',
    ]);
    expect(JSON.stringify(input)).not.toContain(ROOT);
    expect(shadow).toMatchObject({ status: 'COMPLETED', initialSliceCount: 8, contextCheck: { status: 'EXPANDED', addedSliceCount: 7 } });
  });

  it('does not recheck contexts already settled by confirmed witnesses, and hands the Agent the same slices either way', async () => {
    const environment = { ...active, LLM_AGENT_CONTEXT_CHECK_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' };
    const [off, on] = [provider({}, MISSING), provider({}, MISSING)];
    const without = await run({ ...environment, LLM_AGENT_CONTEXT_RECHECK_ENABLED: 'false' }, off);
    const withRecheck = await run({ ...environment, LLM_AGENT_CONTEXT_RECHECK_ENABLED: 'true' }, on);
    expect(off.check).toHaveBeenCalledTimes(1);
    expect(on.check).toHaveBeenCalledTimes(1);
    expect(withRecheck.input.initialCodeSlices).toEqual(without.input.initialCodeSlices);
    expect(without.shadow.contextCheck).not.toHaveProperty('recheck');
    expect(withRecheck.shadow).toMatchObject({ status: 'COMPLETED', contextCheck: { status: 'EXPANDED' } });
    expect(withRecheck.shadow.contextCheck!.recheck).toMatchObject({ callCount: 0, failedCallCount: 0, questions: [] });
  });

  it('still runs the Agent with the original slices when the provider fails', async () => {
    const failing: ContextCheckProvider = { check: jest.fn(async () => { throw new ContextCheckProviderError('timeout', 'TRANSPORT'); }) };
    const { shadow, input } = await run({ ...active, LLM_AGENT_CONTEXT_CHECK_ENABLED: 'true', TYPESAFE_API_KEY: 'test-key' }, failing);
    expect(input.initialCodeSlices).toHaveLength(1);
    expect(shadow).toMatchObject({ status: 'COMPLETED', contextCheck: { status: 'UNAVAILABLE', failureReason: 'TRANSPORT' } });
  });
});

/** GuardDog v3.1.0 rules that can match a JS/TS file or package.json, with the behavior group each one maps to. */
const GUARDDOG_NPM_RULES: Record<string, BehaviorGroup | 'MATCH'> = {
  'capability-filesystem-browser': 'SENSITIVE_READ', 'capability-filesystem-delete': 'FILE_MUTATION', 'capability-filesystem-read': 'SENSITIVE_READ',
  'capability-filesystem-write-executable': 'FILE_MUTATION', 'capability-network-download': 'DOWNLOAD', 'capability-network-lolbas': 'PROCESS_EXEC',
  'capability-network-outbound': 'NETWORK_SEND', 'capability-process-hooks': 'LIFECYCLE', 'capability-process-schedule': 'PERSISTENCE',
  'capability-process-spawn': 'MATCH', 'capability-runtime-clipboard': 'SURVEILLANCE',
  'threat-network-exfiltration': 'NETWORK_SEND', 'threat-network-outbound-shady-links': 'NETWORK_SEND', 'threat-network-exfil-messenger': 'NETWORK_SEND',
  'threat-network-dns-exfil': 'NETWORK_SEND', 'threat-network-exfil-sysinfo': 'COLLECT_AND_SEND', 'threat-npm-dependency-confusion': 'COLLECT_AND_SEND',
  'threat-network-reverse-shell': 'REMOTE_SHELL', 'threat-process-download-exec': 'DOWNLOAD_AND_EXECUTE', 'threat-process-powershell-encoded': 'PROCESS_EXEC',
  'threat-process-spawn-silent': 'PROCESS_EXEC', 'threat-process-injection-dll': 'PROCESS_EXEC', 'threat-process-sysinfo': 'SYSTEM_DISCOVERY',
  'threat-runtime-system-info': 'SYSTEM_DISCOVERY', 'threat-runtime-enumeration': 'SYSTEM_DISCOVERY', 'threat-filesystem-read': 'SENSITIVE_READ',
  'threat-runtime-environment-read': 'SENSITIVE_READ', 'threat-filesystem-destruction': 'FILE_MUTATION', 'threat-filesystem-autostart': 'PERSISTENCE',
  'threat-runtime-keylogging': 'SURVEILLANCE', 'threat-process-memory': 'SURVEILLANCE', 'threat-runtime-self-propagation': 'PROPAGATION',
  'threat-runtime-obfuscation-api': 'DYNAMIC_CODE', 'threat-runtime-obfuscation-base64exec': 'DYNAMIC_CODE',
  'threat-runtime-obfuscation-dynamic-eval': 'DYNAMIC_CODE', 'threat-runtime-obfuscation-steganography': 'DYNAMIC_CODE',
  'threat-runtime-obfuscation-hidden-code': 'DYNAMIC_CODE', 'threat-runtime-obfuscation': 'OBFUSCATION_SIGNAL',
  'threat-runtime-obfuscation-general': 'OBFUSCATION_SIGNAL', 'threat-runtime-obfuscation-js-mangling': 'OBFUSCATION_SIGNAL',
  'threat-runtime-obfuscation-unicode': 'OBFUSCATION_SIGNAL', 'threat-runtime-obfuscation-log-suppress': 'OBFUSCATION_SIGNAL',
  'threat-process-hooks': 'LIFECYCLE', 'threat-npm-preinstall-script': 'LIFECYCLE', 'threat-npm-http-dependency': 'PACKAGE_RISK',
  'threat-process-cryptomining': 'OTHER',
};
/** Custom Rule observation rules that are not in P0_RULE_IDS (they are not exported by the analyzer). */
const CUSTOM_COEXISTENCE_RULES = ['custom.lifecycle-process-coexistence', 'custom.env-network-coexistence', 'custom.sensitive-file-network-coexistence'];
const CUSTOM_RULES = [...Object.values(P0_RULE_IDS), ...CUSTOM_COEXISTENCE_RULES];
const METADATA_RULES = [
  'metadata.lifecycle.preinstall', 'metadata.lifecycle.install', 'metadata.lifecycle.postinstall', 'metadata.lifecycle.prepare',
  'metadata.license.mismatch', 'metadata.repository.mismatch',
];
/** Semgrep signal IDs, GuardDog rules that only match Python files, and Custom Rule IDs nothing emits. */
const UNREGISTERED_RULES = [
  'custom.signal.sensitive-file-access', 'custom.signal.process-access', 'custom.signal.environment-access', 'custom.signal.network-access',
  'threat-runtime-dynamic-loader', 'threat-runtime-obfuscation-chr', 'threat-runtime-obfuscation-import-exec', 'threat-runtime-obfuscation-pyarmor',
  'threat-runtime-screencapture', 'threat-setup-import-aliasing', 'threat-setup-network-in-install', 'threat-setup-suspicious-imports',
  'custom.download-write-coexistence', 'custom.download-execution-coexistence',
];
const ASKED_GROUPS = BEHAVIOR_GROUPS.filter(isAskedBehavior) as AskedBehaviorGroup[];

type ExtraFinding = { findingId: string; ruleId: string; rawMatch?: string | null; analyzer?: string; startLine?: number; filePath?: string; artifactId?: string };

/** Adds Findings bound to install.js of the restored artifact (or to `filePath` / `artifactId`). */
function withFindings(input: Tier3ExecutionInput, extras: ExtraFinding[]): Tier3ExecutionInput {
  for (const extra of extras) {
    const startLine = extra.startLine ?? 18;
    const filePath = extra.filePath ?? 'install.js';
    input.findings.push({
      findingId: extra.findingId, analyzer: extra.analyzer ?? 'guarddog-deobfuscated', analyzerVersion: '1', ruleId: extra.ruleId, kind: 'CAPABILITY',
      description: `Finding of ${extra.ruleId}`, location: { file: filePath, startLine, endLine: startLine }, rawMatch: extra.rawMatch ?? null,
    });
    input.bindings.findingBindings.push({ findingId: extra.findingId, artifactId: extra.artifactId ?? DEOBFUSCATED, filePath, startLine, endLine: startLine });
  }
  return input;
}

/** A Tier 2 status Finding; like the real ones it names a file and has no line. */
function statusFinding(input: Tier3ExecutionInput, ruleId: string, filePath: string): void {
  input.findings.push({
    findingId: `obfuscation:${ruleId}:${filePath}`, analyzer: 'obfuscation', analyzerVersion: '1', ruleId, kind: 'OTHER',
    description: `Status of ${filePath}`, location: { file: filePath, startLine: null, endLine: null }, rawMatch: null,
  });
}

/** Runs the check on `input` with the slices of the plain one-Finding fixture. */
async function checkInput(input: Tier3ExecutionInput, jev: ContextCheckProvider = provider(), staticFilter?: Pick<StaticFilterResult, 'diagnostics'>) {
  const built = await build(execution());
  const rebuild = jest.fn((expanded: Tier3ExecutionInput, supplement: SliceSupplementBudget) => build({ ...expanded, findings: execution().findings, bindings: execution().bindings }, supplement));
  const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, rebuild, policy: POLICY.codeSlices, ...(staticFilter ? { staticFilter } : {}) });
  const notes = (field: string) => outcome.built.input.missingData.filter((item) => item.field === field).map((item) => item.reason);
  return { built, outcome, notes };
}

describe('context check rule mapping', () => {
  it('maps all 64 behavior rules: 62 by rule ID and 2 by what the Finding matched', () => {
    const fixed = Object.values(RULES_BY_BEHAVIOR).flat();
    // 58 exact rule IDs plus the four metadata.lifecycle.* rules matched by prefix.
    expect(fixed).toHaveLength(58);
    expect(new Set(fixed).size).toBe(fixed.length);
    expect([...MATCH_CLASSIFIED_RULES]).toEqual(['custom.collection-source', 'capability-process-spawn']);
    for (const rule of MATCH_CLASSIFIED_RULES) expect(fixed).not.toContain(rule);

    const all = [...Object.keys(GUARDDOG_NPM_RULES), ...CUSTOM_RULES, ...METADATA_RULES];
    expect(Object.keys(GUARDDOG_NPM_RULES)).toHaveLength(46);
    expect(CUSTOM_RULES).toHaveLength(12);
    expect(new Set(all).size).toBe(64);
    const registered = new Set([...fixed, ...MATCH_CLASSIFIED_RULES, ...METADATA_RULES.filter((rule) => rule.startsWith('metadata.lifecycle.'))]);
    expect([...registered].sort()).toEqual([...all].sort());
  });

  it('classifies every GuardDog rule as the design table says', () => {
    for (const [rule, behavior] of Object.entries(GUARDDOG_NPM_RULES)) {
      if (behavior !== 'MATCH') expect(`${rule} -> ${behavior}`).toBe(`${rule} -> ${behaviorGroupForRule(rule)}`);
    }
  });

  it('leaves OTHER to cryptomining and gives every Custom Rule and Metadata rule a behavior group', () => {
    const fixedRules = [...Object.keys(GUARDDOG_NPM_RULES), ...CUSTOM_RULES, ...METADATA_RULES].filter((rule) => !(MATCH_CLASSIFIED_RULES as readonly string[]).includes(rule));
    expect(fixedRules.filter((rule) => behaviorGroupForRule(rule) === 'OTHER')).toEqual(['threat-process-cryptomining']);
    expect(METADATA_RULES.map((rule) => behaviorGroupForRule(rule))).toEqual(['LIFECYCLE', 'LIFECYCLE', 'LIFECYCLE', 'LIFECYCLE', 'PACKAGE_RISK', 'PACKAGE_RISK']);
  });

  it('does not register internal signals or rules that npm packages never produce', () => {
    const fixed = Object.values(RULES_BY_BEHAVIOR).flat();
    for (const rule of UNREGISTERED_RULES) {
      expect(fixed).not.toContain(rule);
      expect(behaviorGroupForRule(rule)).toBe('OTHER');
    }
  });

  it('routes all eight Tier 2 status rules to RESTORATION_STATUS, never to a behavior group', () => {
    const rules = Object.values(OBFUSCATION_RULE_IDS);
    expect(rules).toHaveLength(8);
    const fixed = Object.values(RULES_BY_BEHAVIOR).flat();
    for (const rule of rules) {
      expect(restorationStatusForRule(rule)).toBeDefined();
      expect(fixed).not.toContain(rule);
    }
    expect(restorationStatusForRule(OBFUSCATION_RULE_IDS.restored)).toBe('RESTORED');
    expect(restorationStatusForRule(OBFUSCATION_RULE_IDS.unresolved)).toBe('UNRESOLVED');
    expect(restorationStatusForRule(OBFUSCATION_RULE_IDS.notSelected)).toBe('NOT_SELECTED');
    expect(restorationStatusForRule(OBFUSCATION_RULE_IDS.detected)).toBe('DETECTED');
    expect(restorationStatusForRule(OBFUSCATION_RULE_IDS.encodedString)).toBe('TECHNIQUE');
    // Behavior rules are not statuses, GuardDog obfuscation rules included.
    expect(restorationStatusForRule('threat-runtime-obfuscation')).toBeUndefined();
    expect(restorationStatusForRule('custom.network-outbound')).toBeUndefined();
  });
});

describe('context check match classification', () => {
  it('classifies custom.collection-source by the matched text', () => {
    const classify = (text?: string | null) => behaviorGroupForRule('custom.collection-source', text);
    expect(classify('const host = os.hostname();')).toBe('SYSTEM_DISCOVERY');
    expect(classify('platform()')).toBe('SYSTEM_DISCOVERY');
    expect(classify('process.cwd()')).toBe('SYSTEM_DISCOVERY');
    expect(classify('$(form).serialize()')).toBe('OTHER');
    expect(classify('new FormData(form)')).toBe('OTHER');
    expect(classify('const value = collect();')).toBe('OTHER');
    expect(classify(undefined)).toBe('OTHER');
    expect(classify(null)).toBe('OTHER');
    expect(classify('   ')).toBe('OTHER');
    // Read in the order the rule reads a line: environment, system information, user input.
    expect(classify('const home = process.env.HOME;')).toBe('ENVIRONMENT_READ');
    expect(classify('send(process.env.USER, os.hostname());')).toBe('ENVIRONMENT_READ');
    expect(classify('const text = await clipboard.readText();')).toBe('SURVEILLANCE');
    expect(classify("input.on('keydown', record);")).toBe('SURVEILLANCE');
  });

  it('classifies custom.collection-source by what the rule recorded, before the text', () => {
    const classify = (sourceType: string | undefined, text?: string) => behaviorGroupForRule('custom.collection-source', text, sourceType);
    // A plain configuration variable is not a sensitive read; a credential one is.
    expect(classify('ENVIRONMENT_VARIABLE')).toBe('ENVIRONMENT_READ');
    expect(classify('CREDENTIAL_ENVIRONMENT')).toBe('SENSITIVE_READ');
    expect(behaviorGroupForRule('custom.credential-source', 'process.env.NPM_TOKEN')).toBe('SENSITIVE_READ');
    expect(behaviorGroupForRule('threat-runtime-environment-read', 'process.env')).toBe('SENSITIVE_READ');
    expect(classify('SYSTEM_INFORMATION', 'const value = collect();')).toBe('SYSTEM_DISCOVERY');
    expect(classify('USER_INPUT')).toBe('SURVEILLANCE');
    // A kind without a group of its own, and an unknown one, fall back to the text.
    expect(classify('SERIALIZED_FORM_DATA', 'new FormData(form)')).toBe('OTHER');
    expect(classify('SOMETHING_NEW', 'os.hostname()')).toBe('SYSTEM_DISCOVERY');
    expect(classify('SOMETHING_NEW')).toBe('OTHER');
    // Other rules do not read it.
    expect(behaviorGroupForRule('custom.network-outbound', undefined, 'ENVIRONMENT_VARIABLE')).toBe('NETWORK_SEND');
  });

  it('classifies capability-process-spawn by the matched text', () => {
    const classify = (text?: string | null) => behaviorGroupForRule('capability-process-spawn', text);
    expect(classify('eval(')).toBe('DYNAMIC_CODE');
    expect(classify('new Function(')).toBe('DYNAMIC_CODE');
    expect(classify("require('child_process')")).toBe('PROCESS_EXEC');
    expect(classify('child_process.execSync')).toBe('PROCESS_EXEC');
    expect(classify('{ spawn } = require')).toBe('PROCESS_EXEC');
    // Both in one match: the process call decides.
    expect(classify("eval(require('child_process').execSync(cmd))")).toBe('PROCESS_EXEC');
    expect(classify('run(command)')).toBe('OTHER');
    expect(classify(undefined)).toBe('OTHER');
  });

  it('uses rawMatch first, then only the exact start line of the Finding, and otherwise OTHER', async () => {
    const slices = (await build(execution({ startLine: 16, endLine: 19 }))).input.initialCodeSlices;
    const behaviorOf = (extra: Omit<ExtraFinding, 'findingId'>) => {
      const input = withFindings(execution({ startLine: 16, endLine: 19 }), [{ findingId: 'extra:1', ...extra }]);
      const plan = planFindingGroups(input, slices);
      return [...plan.groups, ...plan.skippedGroups].find((group) => group.findingIds.includes('extra:1'))?.behavior;
    };
    // rawMatch decides even when the line says something else.
    expect(behaviorOf({ ruleId: 'capability-process-spawn', rawMatch: 'eval(', startLine: 18 })).toBe('DYNAMIC_CODE');
    // Line 18 is `const request = https.request(...)`: no process call and no eval.
    expect(behaviorOf({ ruleId: 'capability-process-spawn', startLine: 18 })).toBe('OTHER');
    // Line 16 is `payload = collect();`: not a system information API.
    expect(behaviorOf({ ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', startLine: 16 })).toBe('OTHER');
    // Line 9 holds `Buffer.from(...)`, but it is outside the supplied slices and is never searched.
    expect(behaviorOf({ ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', startLine: 9 })).toBe('OTHER');
  });

  it('reads only the start line: the same pattern on another supplied line does not count', async () => {
    const built = await build(execution({ startLine: 18, endLine: 19 }));
    const [slice] = built.input.initialCodeSlices;
    const slices = [{ ...slice!, content: ['const host = os.hostname();', 'const body = encode(payload);'].join('\n') }];
    const behaviorAt = (startLine: number) => {
      const input = withFindings(execution(), [{ findingId: 'extra:1', ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', startLine }]);
      return planFindingGroups(input, slices).groups.find((group) => group.findingIds.includes('extra:1'))?.behavior;
    };
    expect(behaviorAt(18)).toBe('SYSTEM_DISCOVERY');
    expect(behaviorAt(19)).toBe('OTHER');
  });
});

describe('context check question templates', () => {
  it('defines one evidence boundary, context boundaries, confidence semantics and group aggregation for every question', async () => {
    expect(QUESTION_PREAMBLE).toContain('Do not infer missing code, runtime values, or runtime behavior');
    expect(QUESTION_PREAMBLE).toContain('semantically equivalent operations');
    expect(QUESTION_PREAMBLE).toContain('Score describes the completeness of the supplied evidence');
    expect(QUESTION_PREAMBLE).toContain('clearly absent evidence may receive score 0 with high confidence');
    expect(CONTEXT_GUIDANCE.TRIGGER).toContain('registered callback');
    expect(CONTEXT_GUIDANCE.TRIGGER).toContain('a package lifecycle script, a declared package entry point, another npm script, a function the package exports');
    expect(CONTEXT_GUIDANCE.TRIGGER).toContain('Rate the steps that are supplied, not how likely the start is to happen');
    expect(CONTEXT_GUIDANCE.TRIGGER).toContain('neither called, exported nor registered in the supplied code has no shown path');
    expect(CONTEXT_GUIDANCE.INPUT).toContain('provenance or construction');
    expect(CONTEXT_GUIDANCE.ACTION).toContain('actual call');
    expect(QUESTION_PREAMBLE).toContain('static import/require origin');
    expect(QUESTION_PREAMBLE).toContain('exact callable member');
    expect(QUESTION_PREAMBLE).toContain('explicitly mapped factory/member pair');
    expect(QUESTION_TEMPLATES.COLLECT_AND_SEND.ACTION.criteria[2]).toContain('continuous supplied value path');
    expect(QUESTION_TEMPLATES.DOWNLOAD_AND_EXECUTE.ACTION.criteria[2]).toContain('connects the retrieved value or produced file');
    expect(QUESTION_TEMPLATES.REMOTE_SHELL.ACTION.criteria[2]).toContain('connects the remote-channel value or control path');
    expect(CONTEXT_GUIDANCE.TARGET).toContain('concrete target');
    expect(CONTEXT_GUIDANCE.LINK).toContain('continuous data or control-flow connection');
    expect(groupEvaluationGuidance(1)).toContain('the Finding');
    expect(groupEvaluationGuidance(2)).toContain('independent Findings');

    const input = execution();
    const slices = (await build(input)).input.initialCodeSlices;
    const [group] = buildFindingGroups(input, slices);
    const multi = [{ ...group!, findingIds: [...group!.findingIds, 'second-finding'] }];
    const request = buildContextCheckRequest(input, slices, multi);
    for (const context of CONTEXT_CODES) {
      const instructions = request.questions[`G1__${context}`]!.instructions;
      expect(instructions).toContain(CONTEXT_GUIDANCE[context]);
      expect(instructions).toContain('Evaluate every Finding in this group');
    }
  });

  it('rates for TRIGGER whether the path is supplied from its start, and takes an export or a registration as a start', () => {
    const generic = QUESTION_TEMPLATES.NETWORK_SEND.TRIGGER;
    expect(generic.question).toContain('from its start to the flagged statement');
    expect(generic.criteria[0]).toContain('a function definition alone is not a path');
    expect(generic.criteria[1]).toContain('between the start and the flagged statement remains missing');
    expect(generic.criteria[2]).toContain('an exported function, or a registered callback');
    const lifecycle = QUESTION_TEMPLATES.LIFECYCLE.TRIGGER;
    expect(lifecycle.question).toContain('from an install lifecycle script to the flagged statement');
    expect(lifecycle.criteria[2]).toContain('every required command, module-load, and call step');
  });

  it('uses semantic, non-API-specific coverage for representative behaviors', () => {
    expect(QUESTION_TEMPLATES.NETWORK_SEND.ACTION.question).toContain('API, library, SDK, socket, native binding, or command');
    expect(QUESTION_TEMPLATES.DOWNLOAD.LINK.question).toContain('buffering, decoding, parsing, writing, extraction, or execution');
    expect(QUESTION_TEMPLATES.PROCESS_EXEC.ACTION.question).toContain('process, interpreter, script, worker');
    expect(QUESTION_TEMPLATES.FILE_MUTATION.ACTION.question).toContain('renames, moves, links, extracts');
    expect(QUESTION_TEMPLATES.DYNAMIC_CODE.ACTION.question).toContain('executes, evaluates, imports, compiles, instantiates, or loads');
  });

  it('defines a question and three Score criteria for every context of the 16 asked behavior groups', () => {
    expect(ASKED_GROUPS).toHaveLength(16);
    expect(Object.keys(QUESTION_TEMPLATES).sort()).toEqual([...ASKED_GROUPS].sort());
    const questions: string[] = [];
    for (const behavior of ASKED_GROUPS) {
      expect(Object.keys(QUESTION_TEMPLATES[behavior])).toEqual([...CONTEXT_CODES]);
      for (const context of CONTEXT_CODES) {
        const template = QUESTION_TEMPLATES[behavior][context];
        expect(template.question).toMatch(/^(?:Is|Are) .+\?$/u);
        expect(template.criteria).toHaveLength(3);
        for (const criterion of template.criteria) expect(criterion.length).toBeGreaterThan(20);
        expect(new Set(template.criteria).size).toBe(3);
        questions.push(template.question);
      }
    }
    expect(questions).toHaveLength(80);
    // No behavior group borrows the wording of another one.
    expect(new Set(questions).size).toBe(80);
    // A plain environment variable is not called sensitive.
    expect(Object.values(QUESTION_TEMPLATES.ENVIRONMENT_READ).map((item) => item.question).join(' ')).not.toMatch(/sensitive|credential/iu);
  });

  it('asks 69 questions by default and keeps 11 for contexts a static-filter reason turns on', () => {
    const base = ASKED_GROUPS.flatMap((behavior) => BASE_CONTEXTS[behavior].map((context) => `${behavior}.${context}`));
    expect(base).toHaveLength(69);
    const optional = ASKED_GROUPS.flatMap((behavior) => CONTEXT_CODES.filter((context) => !BASE_CONTEXTS[behavior].includes(context)).map((context) => `${behavior}.${context}`));
    expect(optional).toEqual([
      'SENSITIVE_READ.INPUT', 'ENVIRONMENT_READ.INPUT', 'ENVIRONMENT_READ.ACTION', 'ENVIRONMENT_READ.TARGET', 'DOWNLOAD.INPUT', 'REMOTE_SHELL.INPUT', 'LIFECYCLE.INPUT', 'LIFECYCLE.TARGET', 'PERSISTENCE.INPUT',
      'SURVEILLANCE.INPUT', 'SYSTEM_DISCOVERY.INPUT',
    ]);
    expect(BASE_CONTEXTS.OBFUSCATION_SIGNAL).toEqual([]);
    expect(BASE_CONTEXTS.PACKAGE_RISK).toEqual([]);
    expect(resolveActiveContexts('OBFUSCATION_SIGNAL', ['BEHAVIOR_LINK_UNVERIFIED'])).toEqual([]);
    expect(resolveActiveContexts('PACKAGE_RISK', ['PAYLOAD_CONTENT_UNVERIFIED'])).toEqual([]);
  });

  it('sends the wording of the group itself, also for a context that a reason turned on', async () => {
    const input = twoGroupExecution();
    const slices = (await build(input)).input.initialCodeSlices;
    const groups = buildFindingGroups(input, slices, [diagnostic('A03', [ENV_FINDING]), diagnostic('I02', [HOOK_FINDING])]);
    const request = buildContextCheckRequest(input, slices, groups);
    // A03 turned INPUT on for the SENSITIVE_READ group, I02 turned TARGET on for the LIFECYCLE group.
    expect(Object.keys(request.questions)).toEqual([
      'G1__TRIGGER', 'G1__INPUT', 'G1__ACTION', 'G1__TARGET', 'G1__LINK', 'G2__TRIGGER', 'G2__ACTION', 'G2__TARGET', 'G2__LINK',
    ]);
    expect(request.questions.G1__INPUT!.instructions).toContain(QUESTION_TEMPLATES.SENSITIVE_READ.INPUT.question);
    expect(request.questions.G1__INPUT!.instructions).not.toContain(QUESTION_TEMPLATES.OTHER.INPUT.question);
    expect(request.questions.G1__INPUT!.criteria).toEqual([...QUESTION_TEMPLATES.SENSITIVE_READ.INPUT.criteria]);
    expect(request.questions.G2__TARGET!.instructions).toContain(QUESTION_TEMPLATES.LIFECYCLE.TARGET.question);
    expect(request.questions.G2__TARGET!.criteria).toEqual([...QUESTION_TEMPLATES.LIFECYCLE.TARGET.criteria]);
    // The common rules are sent once, in the state; a question only points to them.
    expect((request.state as { rules: string }).rules).toBe(QUESTION_PREAMBLE);
    for (const question of Object.values(request.questions)) {
      expect(question.instructions.startsWith(`${RULES_REFERENCE} Finding group`)).toBe(true);
      expect(question.instructions).not.toContain(QUESTION_PREAMBLE);
    }
  });
});

describe('context check group selection', () => {
  it('ranks composite threats, threats, lifecycle/persistence/propagation, capabilities, then custom-only groups', () => {
    expect(groupPriority('COLLECT_AND_SEND', ['custom.env-network-coexistence'])).toBe(1);
    expect(groupPriority('REMOTE_SHELL', ['threat-network-reverse-shell'])).toBe(1);
    expect(groupPriority('NETWORK_SEND', ['custom.network-outbound', 'threat-network-exfiltration'])).toBe(2);
    expect(groupPriority('LIFECYCLE', ['threat-process-hooks'])).toBe(2);
    expect(groupPriority('LIFECYCLE', ['custom.lifecycle-entry'])).toBe(3);
    expect(groupPriority('PERSISTENCE', ['capability-process-schedule'])).toBe(3);
    expect(groupPriority('SENSITIVE_READ', ['capability-filesystem-read', 'custom.credential-source'])).toBe(4);
    expect(groupPriority('SYSTEM_DISCOVERY', ['custom.collection-source'])).toBe(5);
    expect(groupPriority('OTHER', ['custom.collection-source'])).toBe(5);
  });

  /** One Finding for each of the 15 asked behavior groups, all in the sliced lines of install.js. */
  function fifteenGroups(): Tier3ExecutionInput {
    return withFindings(execution(), [
      { findingId: 'f:collect-send', ruleId: 'threat-network-exfil-sysinfo' },
      { findingId: 'f:read', ruleId: 'capability-filesystem-read' },
      { findingId: 'f:download', ruleId: 'custom.remote-download', analyzer: 'custom-rule-deobfuscated' },
      { findingId: 'f:download-exec', ruleId: 'threat-process-download-exec' },
      { findingId: 'f:shell', ruleId: 'threat-network-reverse-shell' },
      { findingId: 'f:exec', ruleId: 'custom.process-execution', analyzer: 'custom-rule-deobfuscated' },
      { findingId: 'f:write', ruleId: 'custom.filesystem.write', analyzer: 'custom-rule-deobfuscated' },
      { findingId: 'f:lifecycle', ruleId: 'custom.lifecycle-entry', analyzer: 'custom-rule-deobfuscated' },
      { findingId: 'f:persist', ruleId: 'capability-process-schedule' },
      { findingId: 'f:keylog', ruleId: 'threat-runtime-keylogging' },
      { findingId: 'f:sysinfo', ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', rawMatch: 'os.hostname()' },
      { findingId: 'f:propagate', ruleId: 'threat-runtime-self-propagation' },
      { findingId: 'f:dynamic', ruleId: 'threat-runtime-obfuscation-api' },
      { findingId: 'f:other', ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', rawMatch: 'new FormData(form)' },
    ]);
  }

  it('groups a Finding by the source kind its rule recorded, which never enters the Agent input', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:env', ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', rawMatch: 'collect()' }]);
    const built = await build(input);
    const behaviorOf = (plan: ReturnType<typeof planFindingGroups>) => plan.groups.find((group) => group.findingIds.includes('f:env'))?.behavior;
    expect(behaviorOf(planFindingGroups(input, built.input.initialCodeSlices))).toBe('OTHER');
    input.findingAttributes = { 'f:env': { sourceType: 'ENVIRONMENT_VARIABLE' } };
    expect(behaviorOf(planFindingGroups(input, built.input.initialCodeSlices))).toBe('ENVIRONMENT_READ');
    // The read is its own operation and names its own variable, so only when it runs and where the value goes are asked.
    expect(planFindingGroups(input, built.input.initialCodeSlices).groups.find((group) => group.findingIds.includes('f:env'))?.contexts).toEqual(['TRIGGER', 'LINK']);
    expect(JSON.stringify((await build(input)).input)).not.toMatch(/findingAttributes|sourceType/u);
  });

  it('does not ask about a user-input Finding whose line holds no clipboard or key-event API, and tells Tier 3', async () => {
    const add = (rawMatch: string) => withFindings(execution(), [{ findingId: 'f:input', ruleId: 'custom.collection-source', analyzer: 'custom-rule-deobfuscated', rawMatch }]);
    const slices = (await build(execution())).input.initialCodeSlices;
    const plain = add('const chunk = await reader.read();');
    plain.findingAttributes = { 'f:input': { sourceType: 'USER_INPUT' } };
    const plan = planFindingGroups(plain, slices);
    expect(plan.groups.some((group) => group.findingIds.includes('f:input'))).toBe(false);
    expect(plan.skippedGroups).toEqual([{ filePath: 'install.js', behavior: 'SURVEILLANCE', findingIds: ['f:input'], reason: 'UNSUPPORTED_MATCH' }]);
    const { notes } = await checkInput(plain);
    expect(notes('contextCheck')).toContain('install.js (SURVEILLANCE): not context-checked; reason=UNSUPPORTED_MATCH; findings=f:input');
    // A clipboard or key-event API on the line keeps the Finding in SURVEILLANCE.
    for (const text of ['const text = await clipboard.readText();', "input.on('keydown', record);"]) {
      const real = add(text);
      real.findingAttributes = { 'f:input': { sourceType: 'USER_INPUT' } };
      expect(planFindingGroups(real, slices).groups.find((group) => group.findingIds.includes('f:input'))?.behavior).toBe('SURVEILLANCE');
      expect(planFindingGroups(real, slices).skippedGroups).toEqual([]);
    }
  });

  it('does not ask about type declaration files', () => {
    expect(['lib/index.d.ts', 'lib/index.d.mts', 'lib/index.d.cts'].map(isSupportedFile)).toEqual([false, false, false]);
    expect(['lib/index.ts', 'lib/d.ts', 'lib/index.js'].map(isSupportedFile)).toEqual([true, true, true]);
  });

  it('puts a download Finding on the line of a send Finding into the send group', async () => {
    const slices = (await build(execution())).input.initialCodeSlices;
    const groupsOf = (startLine: number, sendRule = 'custom.network-outbound') => planFindingGroups(withFindings(execution(), [
      { findingId: 'f:send', ruleId: sendRule, startLine: 20 },
      { findingId: 'f:download', ruleId: 'custom.remote-download', startLine },
      { findingId: 'f:download-2', ruleId: 'capability-network-download', startLine },
    ]), slices).groups.filter((group) => group.findingIds.some((id) => id.startsWith('f:'))).map((group) => `${group.behavior} ${group.findingIds.filter((id) => id.startsWith('f:')).join(',')}`);
    expect(groupsOf(20)).toEqual(['NETWORK_SEND f:send,f:download,f:download-2']);
    expect(groupsOf(20, 'threat-network-exfil-sysinfo')).toEqual(['COLLECT_AND_SEND f:send,f:download,f:download-2']);
    // On a line of its own a download stays a download.
    expect(groupsOf(21).sort()).toEqual(['DOWNLOAD f:download,f:download-2', 'NETWORK_SEND f:send']);
  });

  it('asks at most 12 groups, picked by priority and then by behavior order, and records the rest', async () => {
    const input = fifteenGroups();
    const slices = (await build(execution())).input.initialCodeSlices;
    const plan = planFindingGroups(input, slices);
    expect(plan.groups.map((group) => `${group.groupId} ${group.priority} ${group.behavior}`)).toEqual([
      'G1 1 COLLECT_AND_SEND', 'G2 1 DOWNLOAD_AND_EXECUTE', 'G3 1 REMOTE_SHELL',
      'G4 2 SURVEILLANCE', 'G5 2 PROPAGATION', 'G6 2 DYNAMIC_CODE',
      'G7 3 LIFECYCLE', 'G8 3 PERSISTENCE',
      'G9 4 SENSITIVE_READ',
      // The download Finding is on the line of the send Finding and joins its group.
      'G10 5 NETWORK_SEND', 'G11 5 PROCESS_EXEC', 'G12 5 FILE_MUTATION',
    ]);
    expect(plan.groups).toHaveLength(CONTEXT_CHECK_LIMITS.maxGroups);
    // custom.collection-source groups are last in line and do not push out a threat group.
    expect(plan.skippedGroups).toEqual([
      { filePath: 'install.js', behavior: 'SYSTEM_DISCOVERY', findingIds: ['f:sysinfo'], reason: 'GROUP_LIMIT' },
      { filePath: 'install.js', behavior: 'OTHER', findingIds: ['f:other'], reason: 'GROUP_LIMIT' },
    ]);
  });

  it('tells Tier 3 which groups were left out by the group limit', async () => {
    const { outcome, notes } = await checkInput(fifteenGroups());
    expect(outcome.record).toMatchObject({ status: 'SUFFICIENT', groupCount: 12 });
    expect(outcome.record.skippedGroups.map((group) => `${group.behavior} ${group.reason}`)).toEqual([
      'SYSTEM_DISCOVERY GROUP_LIMIT', 'OTHER GROUP_LIMIT',
    ]);
    expect(notes('contextCheck')).toEqual([
      'install.js (SYSTEM_DISCOVERY): not context-checked; reason=GROUP_LIMIT; findings=f:sysinfo',
      'install.js (OTHER): not context-checked; reason=GROUP_LIMIT; findings=f:other',
    ]);
    // The Findings themselves stay in the Agent input.
    expect(outcome.built.input.findings).toEqual((await build(execution())).input.findings);
  });

  it('orders equal priorities by artifact, then file, then behavior', async () => {
    const input = withFindings(execution(), [
      { findingId: 'f:b-exec', ruleId: 'custom.process-execution', analyzer: 'custom-rule', filePath: 'lib/collect.js', artifactId: ORIGINAL, startLine: 5 },
      { findingId: 'f:b-net', ruleId: 'custom.network-outbound', analyzer: 'custom-rule', filePath: 'lib/collect.js', artifactId: ORIGINAL, startLine: 5 },
      { findingId: 'f:a-exec', ruleId: 'custom.process-execution', analyzer: 'custom-rule-deobfuscated' },
    ]);
    const base = await build(execution());
    const [slice] = base.input.initialCodeSlices;
    const slices = [slice!, { ...slice!, artifactId: ORIGINAL, filePath: 'lib/collect.js', startLine: 4, endLine: 6 }];
    // DEOBFUSCATED sorts before ORIGINAL; within a file NETWORK_SEND comes before PROCESS_EXEC.
    expect(planFindingGroups(input, slices).groups.map((group) => `${group.artifactId === ORIGINAL ? 'ORIGINAL' : 'DEOBFUSCATED'} ${group.filePath} ${group.behavior}`)).toEqual([
      'DEOBFUSCATED install.js NETWORK_SEND', 'DEOBFUSCATED install.js PROCESS_EXEC', 'ORIGINAL lib/collect.js NETWORK_SEND', 'ORIGINAL lib/collect.js PROCESS_EXEC',
    ]);
  });

  it('leaves out the lowest-priority group first when the request is too large', async () => {
    const input = withFindings(execution(undefined, 'threat-network-exfiltration'), [
      { findingId: 'f:big', ruleId: 'custom.process-execution', analyzer: 'custom-rule', filePath: 'lib/collect.js', artifactId: ORIGINAL, startLine: 5 },
    ]);
    const base = await build(execution());
    const [slice] = base.input.initialCodeSlices;
    const big = { ...slice!, sliceId: 'SLICE-BIG', artifactId: ORIGINAL, filePath: 'lib/collect.js', startLine: 4, endLine: 6, content: 'x'.repeat(CONTEXT_CHECK_LIMITS.maxStateChars) };
    const built = { ...base, input: { ...base.input, initialCodeSlices: [slice!, big] } };
    const jev = provider();
    const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, rebuild: build, policy: POLICY.codeSlices });
    expect(jev.check).toHaveBeenCalledTimes(1);
    const request = jev.check.mock.calls[0]![0];
    // Only the threat group is asked, and the slices of the dropped group's file are not sent.
    expect(Object.keys(request.questions)).toEqual(CONTEXT_CODES.map((code) => `G1__${code}`));
    expect(JSON.stringify(request.state)).not.toContain('SLICE-BIG');
    expect(outcome.record).toMatchObject({
      status: 'SUFFICIENT', groupCount: 1,
      skippedGroups: [{ filePath: 'lib/collect.js', behavior: 'PROCESS_EXEC', findingIds: ['f:big'], reason: 'INPUT_LIMIT' }],
    });
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: 'lib/collect.js (PROCESS_EXEC): not context-checked; reason=INPUT_LIMIT; findings=f:big' },
    ]);
    // The Agent still gets every slice.
    expect(outcome.built.input.initialCodeSlices).toBe(built.input.initialCodeSlices);
  });
});

describe('context check questions that are not asked', () => {
  it('never asks PACKAGE_RISK and reports nothing for it', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:http-dep', ruleId: 'threat-npm-http-dependency' }, { findingId: 'f:license', ruleId: 'metadata.license.mismatch', analyzer: 'metadata' }]);
    const jev = provider();
    const { outcome, notes } = await checkInput(input, jev);
    expect(Object.keys(jev.check.mock.calls[0]![0].questions)).toEqual(CONTEXT_CODES.map((code) => `G1__${code}`));
    expect(outcome.record).toMatchObject({ status: 'SUFFICIENT', groupCount: 1, skippedGroups: [], preservedReasons: [], restorationStatus: [] });
    expect(notes('contextCheck')).toEqual([]);
    expect(notes('restorationStatus')).toEqual([]);
    expect(notes('staticFilterReason')).toEqual([]);
  });

  it('never asks OBFUSCATION_SIGNAL and reports nothing when the file has no restoration problem', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:mangling', ruleId: 'threat-runtime-obfuscation-js-mangling' }]);
    statusFinding(input, OBFUSCATION_RULE_IDS.detected, 'install.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.restored, 'install.js');
    const jev = provider();
    const { outcome, notes } = await checkInput(input, jev);
    expect(Object.keys(jev.check.mock.calls[0]![0].questions)).toEqual(CONTEXT_CODES.map((code) => `G1__${code}`));
    expect(outcome.record.skippedGroups).toEqual([]);
    expect(outcome.built.input.missingData).toEqual((await build(execution())).input.missingData);
    expect(notes('restorationStatus')).toEqual([]);
  });

  it('attaches OBFUSCATION_SIGNAL Findings to the restoration note of an unresolved file', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:mangling', ruleId: 'threat-runtime-obfuscation-js-mangling' }]);
    statusFinding(input, OBFUSCATION_RULE_IDS.unresolved, 'install.js');
    const { outcome, notes } = await checkInput(input);
    expect(notes('restorationStatus')).toEqual(['install.js: restoration status=UNRESOLVED; techniques=none; obfuscation signal findings=f:mangling']);
    expect(outcome.record.restorationStatus).toEqual([{ filePath: 'install.js', status: 'UNRESOLVED', techniques: [], signalFindingIds: ['f:mangling'] }]);
  });

  it('skips a Finding in a file type the expansion cannot parse and says so', async () => {
    expect(['a.js', 'a.cjs', 'a.mjs', 'a.jsx', 'a.ts', 'a.tsx', 'package.json', 'sub/package.json'].every(isSupportedFile)).toBe(true);
    expect(['a.py', 'setup.py', 'run.sh', 'data.json', 'a.rb', 'README.md'].some(isSupportedFile)).toBe(false);

    const input = withFindings(execution(), [{ findingId: 'f:py', ruleId: 'capability-network-outbound', analyzer: 'guarddog', filePath: 'lib/util.py', artifactId: ORIGINAL, startLine: 3 }]);
    const base = await build(execution());
    const [slice] = base.input.initialCodeSlices;
    const built = { ...base, input: { ...base.input, initialCodeSlices: [slice!, { ...slice!, artifactId: ORIGINAL, filePath: 'lib/util.py', startLine: 1, endLine: 5 }] } };
    const jev = provider();
    const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, rebuild: build, policy: POLICY.codeSlices });
    expect(Object.keys(jev.check.mock.calls[0]![0].questions)).toEqual(CONTEXT_CODES.map((code) => `G1__${code}`));
    expect(outcome.record.skippedGroups).toEqual([{ filePath: 'lib/util.py', behavior: 'NETWORK_SEND', findingIds: ['f:py'], reason: 'UNSUPPORTED_FILE' }]);
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toEqual([
      { field: 'contextCheck', reason: 'lib/util.py (NETWORK_SEND): not context-checked; reason=UNSUPPORTED_FILE; findings=f:py' },
    ]);
  });

  it('reports unsupported files even when no group is left to ask', async () => {
    const input = execution();
    input.findings[0]!.location = { file: 'lib/util.py', startLine: 3, endLine: 3 };
    input.bindings.findingBindings[0] = { findingId: FINDING, artifactId: ORIGINAL, filePath: 'lib/util.py', startLine: 3, endLine: 3 };
    const base = await build(execution());
    const built = { ...base, input: { ...base.input, initialCodeSlices: [{ ...base.input.initialCodeSlices[0]!, artifactId: ORIGINAL, filePath: 'lib/util.py', startLine: 1, endLine: 5 }] } };
    const jev = provider();
    const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, rebuild: build, policy: POLICY.codeSlices });
    expect(jev.check).not.toHaveBeenCalled();
    expect(outcome.record).toMatchObject({ status: 'NO_GROUPS', skippedGroups: [{ filePath: 'lib/util.py', reason: 'UNSUPPORTED_FILE' }] });
    expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck')).toHaveLength(1);
  });

  it('does not report a provider failure as missing data', async () => {
    const failing: ContextCheckProvider = { check: jest.fn(async () => { throw new ContextCheckProviderError('HTTP 529', 'HTTP'); }) };
    const input = withFindings(execution(), [{ findingId: 'f:mangling', ruleId: 'threat-runtime-obfuscation-js-mangling' }]);
    statusFinding(input, OBFUSCATION_RULE_IDS.unresolved, 'install.js');
    const { built, outcome } = await checkInput(input, failing);
    expect(outcome.built).toBe(built);
    expect(outcome.record).toMatchObject({ status: 'UNAVAILABLE', failureReason: 'HTTP' });
  });
});

describe('context check restoration status', () => {
  it('makes no group and no question out of Tier 2 status Findings', async () => {
    const input = execution();
    for (const rule of Object.values(OBFUSCATION_RULE_IDS)) {
      statusFinding(input, rule, 'install.js');
      // Even a status Finding bound to a sliced file is not a behavior.
      input.bindings.findingBindings.push({ findingId: `obfuscation:${rule}:install.js`, artifactId: DEOBFUSCATED, filePath: 'install.js' });
    }
    const slices = (await build(execution())).input.initialCodeSlices;
    const plan = planFindingGroups(input, slices);
    expect(plan.groups.map((group) => `${group.behavior} ${group.findingIds.join(',')}`)).toEqual([`NETWORK_SEND ${FINDING}`]);
    expect(plan.skippedGroups).toEqual([]);
    expect([...plan.groups, ...plan.skippedGroups].some((group) => group.behavior === 'OTHER')).toBe(false);
  });

  it('adds nothing for a restored file and reports unresolved and not-selected files', async () => {
    const input = execution();
    statusFinding(input, OBFUSCATION_RULE_IDS.detected, 'lib/restored.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.encodedString, 'lib/restored.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.restored, 'lib/restored.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.detected, 'lib/failed.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.identifierMangling, 'lib/failed.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.encodedString, 'lib/failed.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.unresolved, 'lib/failed.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.controlFlowFlattening, 'lib/skipped.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.notSelected, 'lib/skipped.js');
    // Detection and technique alone are kept in the record but are not missing data.
    statusFinding(input, OBFUSCATION_RULE_IDS.detected, 'lib/detected-only.js');
    statusFinding(input, OBFUSCATION_RULE_IDS.dynamicEval, 'lib/detected-only.js');

    const { outcome, notes } = await checkInput(input);
    expect(notes('restorationStatus')).toEqual([
      'lib/failed.js: restoration status=UNRESOLVED; techniques=encoded-string,identifier-mangling',
      'lib/skipped.js: restoration status=NOT_SELECTED; techniques=control-flow-flattening',
    ]);
    expect(outcome.record.restorationStatus).toEqual([
      { filePath: 'lib/detected-only.js', status: 'DETECTED', techniques: ['dynamic-eval'], signalFindingIds: [] },
      { filePath: 'lib/failed.js', status: 'UNRESOLVED', techniques: ['encoded-string', 'identifier-mangling'], signalFindingIds: [] },
      { filePath: 'lib/restored.js', status: 'RESTORED', techniques: ['encoded-string'], signalFindingIds: [] },
      { filePath: 'lib/skipped.js', status: 'NOT_SELECTED', techniques: ['control-flow-flattening'], signalFindingIds: [] },
    ]);
    expect(outcome.record.status).toBe('SUFFICIENT');
  });

  it('checks a behavior Finding of the restored code in its own behavior group', async () => {
    const input = withFindings(execution(), [{ findingId: 'guarddog-deobfuscated:capability-network-outbound:0', ruleId: 'capability-network-outbound' }]);
    statusFinding(input, OBFUSCATION_RULE_IDS.restored, 'install.js');
    const jev = provider();
    const { outcome } = await checkInput(input, jev);
    expect(outcome.record.states.map((state) => `${state.behavior}.${state.context}`)).toEqual(CONTEXT_CODES.map((code) => `NETWORK_SEND.${code}`));
    expect(Object.keys(jev.check.mock.calls[0]![0].questions)).toHaveLength(CONTEXT_CODES.length);
  });

  it('creates no status and no obfuscation group for a package without obfuscation Findings', async () => {
    const { built, outcome } = await checkInput(execution());
    expect(outcome.record).toMatchObject({ status: 'SUFFICIENT', restorationStatus: [], skippedGroups: [], preservedReasons: [] });
    expect(outcome.built).toBe(built);
  });

  it('lists at most 12 files and summarizes the rest', async () => {
    const input = execution();
    for (let index = 1; index <= 15; index += 1) statusFinding(input, OBFUSCATION_RULE_IDS.unresolved, `lib/file-${String(index).padStart(2, '0')}.js`);
    const { outcome, notes } = await checkInput(input);
    expect(notes('restorationStatus')).toHaveLength(CONTEXT_CHECK_LIMITS.maxNotesPerKind + 1);
    expect(notes('restorationStatus').at(-1)).toBe('3 more files with an incomplete restoration are not listed.');
    expect(outcome.record.restorationStatus).toHaveLength(15);
  });
});

describe('context check preserved static-filter reasons', () => {
  it('adds no context for A07 and hands the reason to Tier 3 and to the record', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:keylog', ruleId: 'threat-runtime-keylogging' }]);
    const jev = provider();
    const { outcome, notes } = await checkInput(input, jev, { diagnostics: [diagnostic('A07', [], { findingRefs: [{ analyzer: 'guarddog-deobfuscated', findingId: 'f:keylog' }] })] });
    // SURVEILLANCE asks its four base contexts; A07 turns nothing on.
    expect(Object.keys(jev.check.mock.calls[0]![0].questions).filter((key) => key.startsWith('G1__'))).toEqual(['G1__TRIGGER', 'G1__ACTION', 'G1__TARGET', 'G1__LINK']);
    expect(outcome.record.preservedReasons).toEqual([{ filePath: 'install.js', behavior: 'SURVEILLANCE', findingIds: ['f:keylog'], reasonCodes: ['DUAL_USE_CONTEXT_UNRESOLVED'] }]);
    expect(notes('staticFilterReason')).toEqual([
      'install.js (SURVEILLANCE): static filter reason DUAL_USE_CONTEXT_UNRESOLVED applies; no additional context was requested; findings=f:keylog',
    ]);
  });

  it('preserves reasons that more code cannot settle, only for the group their Findings are in', async () => {
    const input = twoGroupExecution();
    const slices = (await build(input)).input.initialCodeSlices;
    const plan = planFindingGroups(input, slices, [
      diagnostic('A01', [ENV_FINDING]), diagnostic('I01', [ENV_FINDING]), diagnostic('I04', [ENV_FINDING]), diagnostic('I05', [ENV_FINDING]),
      diagnostic('I06', [ENV_FINDING]), diagnostic('I08', [ENV_FINDING, HOOK_FINDING]), diagnostic('A03', [HOOK_FINDING]),
    ]);
    expect(plan.groups.map((group) => group.contexts)).toEqual([SENSITIVE_READ_BASE, ['TRIGGER', 'INPUT', 'ACTION', 'LINK']]);
    expect(plan.preservedReasons).toEqual([{
      filePath: 'install.js', behavior: 'SENSITIVE_READ', findingIds: [ENV_FINDING],
      reasonCodes: ['OBFUSCATION_UNRESOLVED', 'ANALYZER_INCOMPLETE', 'RESTORATION_INCOMPLETE', 'RESTORATION_BUDGET_EXCEEDED', 'PROVENANCE_INCOMPLETE'],
    }]);
  });

  it('keeps A01 for an OBFUSCATION_SIGNAL group although the group is not asked', async () => {
    const input = withFindings(execution(), [{ findingId: 'f:mangling', ruleId: 'threat-runtime-obfuscation-js-mangling' }]);
    const { notes } = await checkInput(input, provider(), { diagnostics: [diagnostic('A01', [], { findingRefs: [{ analyzer: 'guarddog-deobfuscated', findingId: 'f:mangling' }] })] });
    expect(notes('staticFilterReason')).toEqual([
      'install.js (OBFUSCATION_SIGNAL): static filter reason OBFUSCATION_UNRESOLVED applies; no additional context was requested; findings=f:mangling',
    ]);
    expect(notes('contextCheck')).toEqual([]);
  });

  it('adds ACTION and TARGET for I02 on the group that holds the Finding', async () => {
    expect(await groupContexts([diagnostic('I02', [HOOK_FINDING])])).toEqual({ read: SENSITIVE_READ_BASE, lifecycle: ['TRIGGER', 'ACTION', 'TARGET', 'LINK'] });
  });
});

describe('context check expansion by behavior', () => {
  it('makes no candidate for a context the group does not ask', async () => {
    // SENSITIVE_READ does not ask INPUT, so an all-MISSING answer never looks for INPUT code.
    const input = execution(undefined, 'threat-runtime-environment-read');
    const { outcome } = await check({ input, provider: provider({}, MISSING) });
    expect(outcome.record.states.map((state) => state.context)).toEqual(['TRIGGER', 'ACTION', 'TARGET', 'LINK']);
    expect(outcome.built.input.analysisPlan.targets.slice(1).flatMap((target) => target.reasonCodes)).not.toContain('CONTEXT_INPUT');
  });

  it('adds the file a lifecycle script runs when a LIFECYCLE group lacks ACTION, and nothing from package.json itself', async () => {
    const input = execution(undefined, 'metadata.lifecycle.postinstall');
    input.findings[0]!.location = { file: 'package.json', startLine: 7, endLine: 7 };
    input.bindings.findingBindings[0] = { findingId: FINDING, artifactId: ORIGINAL, filePath: 'package.json', startLine: 7, endLine: 7 };
    const base = await build(execution());
    const slices = [{ ...base.input.initialCodeSlices[0]!, artifactId: ORIGINAL, filePath: 'package.json', startLine: 6, endLine: 8 }];
    const [group] = buildFindingGroups(input, slices);
    expect(group).toMatchObject({ behavior: 'LIFECYCLE', filePath: 'package.json', contexts: ['TRIGGER', 'ACTION', 'LINK'] });
    const candidates = await generateExpansionCandidates({
      unresolved: [{ group: group!, context: 'ACTION', state: 'MISSING' }, { group: group!, context: 'LINK', state: 'MISSING' }],
      slices, resolver: input.artifacts, packageContext: input.packageContext, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
    });
    // ACTION gets the lifecycle script file only (not the entry point); LINK has nothing because package.json is not parsed.
    // MISSING ACTION then takes one more hop: install.js requires ./lib/collect.
    expect(candidates.map(({ context, kind, depth, filePath, startLine, endLine }) => `${context} ${kind} ${depth} ${filePath}:${startLine}-${endLine}`)).toEqual([
      // What the obfuscated install.js runs at load time (lines 3-8), then the export of ./lib/collect it requires.
      'ACTION LIFECYCLE_ENTRY 1 install.js:3-8',
      'ACTION STATIC_IMPORT 2 lib/collect.js:4-8',
    ]);
  });

  it('keeps lifecycle files out of ACTION for other behavior groups', async () => {
    const input = execution();
    const slices = (await build(input)).input.initialCodeSlices;
    const [group] = buildFindingGroups(input, slices);
    const candidates = await generateExpansionCandidates({
      unresolved: [{ group: group!, context: 'ACTION', state: 'MISSING' }],
      slices, resolver: input.artifacts, packageContext: input.packageContext, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
    });
    // Lines 18-19 use no import, so only the local function is offered.
    expect(candidates.map((candidate) => candidate.kind)).toEqual(['LOCAL_FUNCTION']);
  });
});

describe('context check statement-level candidates', () => {
  const ARTIFACT = 'ARTIFACT-HOP';
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

  async function project(files: Record<string, string[]>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'context-check-hop-'));
    roots.push(root);
    for (const [path, lines] of Object.entries(files)) await writeFile(join(root, path), `${lines.join('\n')}\n`);
    return root;
  }

  /** One Finding of `ruleId` at `line` of `file`, sliced alone; `scripts` become lifecycle scripts. */
  function projectExecution(root: string, file: string, line: number, options: { ruleId?: string; scripts?: Record<string, string>; main?: string } = {}): Tier3ExecutionInput {
    const scripts = options.scripts ?? {};
    return {
      validatedPlan: {
        planId: 'PLAN-HOP', shouldExecute: true, analysisMode: 'ORIGINAL_ONLY',
        targets: [{ targetId: 'tier3-target-001', artifactId: ARTIFACT, filePath: file, preferredRange: { startLine: line, endLine: line }, priority: 'HIGH', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: ['TIER1_FINDING'] }],
        focusBehaviors: ['NETWORK_EGRESS'], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' },
      },
      artifacts: new StaticArtifactResolver([{ root, descriptor: { artifactId: ARTIFACT, representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: HASH, lineageStatus: 'DIRECT', producer: 'safe-extract' } }]),
      findings: [{ findingId: FINDING, analyzer: 'custom-rule', analyzerVersion: '1', ruleId: options.ruleId ?? 'custom.network-outbound', kind: 'CAPABILITY', description: 'Finding', location: { file, startLine: line, endLine: line }, rawMatch: null }],
      atomicEvidences: [],
      bindings: { findingBindings: [{ findingId: FINDING, artifactId: ARTIFACT, filePath: file, startLine: line, endLine: line }], evidenceBindings: [] },
      packageContext: {
        source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', description: null, main: options.main ?? null, exports: null, scripts, dependencies: {},
        entryPoints: options.main ? [{ type: 'MAIN', value: options.main, location: null }] : [],
        lifecycleScripts: Object.entries(scripts).map(([name, command]) => ({ name: name as 'postinstall', command, location: null })),
      },
    };
  }

  type Answer = [ContextCode, 'MISSING' | 'PARTIAL'];
  async function candidatesFor(files: Record<string, string[]>, file: string, line: number, unresolved: Answer[], options: Parameters<typeof projectExecution>[3] = {}) {
    const input = projectExecution(await project(files), file, line, options);
    const slices = (await build(input)).input.initialCodeSlices;
    const [group] = buildFindingGroups(input, slices);
    return generateExpansionCandidates({
      unresolved: unresolved.map(([context, state]) => ({ group: group!, context, state })),
      slices, resolver: input.artifacts, packageContext: input.packageContext, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
    });
  }
  const describeCandidates = (candidates: readonly ExpansionCandidate[]) => candidates.map(({ context, state, depth, kind, filePath, startLine, endLine, symbol }) => (
    `${context} ${state} ${depth} ${kind} ${filePath}:${startLine}-${endLine}${symbol ? ` ${symbol}` : ''}`
  ));

  async function runOn(files: Record<string, string[]>, file: string, line: number, answers: Partial<Record<string, ScoreAnswer>>, policy = POLICY, options: Parameters<typeof projectExecution>[3] = {}) {
    const input = projectExecution(await project(files), file, line, options);
    const built = await build(input, undefined, policy);
    const trace: CandidateTraceEntry[] = [];
    const outcome = await runContextCheck({
      enabled: true, provider: provider(answers), execution: input, built, policy: policy.codeSlices,
      rebuild: (expanded, supplement) => build(expanded, supplement, policy),
      onCandidateTrace: (entries) => trace.push(...entries),
    });
    return { input, built, outcome, trace };
  }
  const describeTrace = (trace: readonly CandidateTraceEntry[]) => trace.map((entry) => (
    `${entry.depth} ${entry.kind} ${entry.filePath}:${entry.candidateStartLine}-${entry.candidateEndLine} `
    + (entry.selected ? `-> ${entry.selectedStartLine}-${entry.selectedEndLine}` : `${entry.exclusionReason}`)
  ));

  describe('selection of complete, new statements', () => {
    const SAMPLE = {
      'sample.js': [
        '// header comment', '', '/* block', '   comment */', 'function helper(value) {', '  return value * 2;', '}', '});', 'const result = helper(1);',
        ...Array.from({ length: 70 }, (_, index) => (index === 0 ? 'function big() {' : index === 69 ? '}' : `  step(${index});`)),
      ],
    };
    const unitCandidate = (units: Array<{ startLine: number; endLine: number }>, overrides: Partial<ExpansionCandidate> = {}): ExpansionCandidate => ({
      groupId: 'G1', context: 'LINK', state: 'MISSING', kind: 'LOCAL_FUNCTION', depth: 1, artifactId: ARTIFACT, filePath: 'sample.js',
      startLine: Math.min(...units.map((unit) => unit.startLine)), endLine: Math.max(...units.map((unit) => unit.endLine)), units, statementAligned: true, ...overrides,
    });
    async function validateSample(candidates: ExpansionCandidate[], options: { supplied?: Array<{ startLine: number; endLine: number }>; remainingSlices?: number; remainingLines?: number; maxLinesPerCandidate?: number } = {}) {
      const input = projectExecution(await project(SAMPLE), 'sample.js', 9);
      const base = (await build(input)).input.initialCodeSlices[0]!;
      const slices = (options.supplied ?? [{ startLine: 9, endLine: 9 }]).map((range, index) => ({ ...base, sliceId: `SLICE-T-${index}`, ...range }));
      return validateExpansionCandidates({
        candidates, groups: buildFindingGroups(input, slices), slices, resolver: input.artifacts, analysisMode: 'ORIGINAL_ONLY',
        remainingSlices: options.remainingSlices ?? 9, remainingLines: options.remainingLines ?? 120, maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
        ...(options.maxLinesPerCandidate === undefined ? {} : { maxLinesPerCandidate: options.maxLinesPerCandidate }),
      });
    }

    it('excludes candidates that hold only comments, whitespace or punctuation, without using a slot or lines', async () => {
      const result = await validateSample([unitCandidate([{ startLine: 1, endLine: 4 }]), unitCandidate([{ startLine: 8, endLine: 8 }]), unitCandidate([{ startLine: 5, endLine: 7 }])], { remainingSlices: 1 });
      expect(result.trace.map((entry) => entry.exclusionReason)).toEqual(['NO_MEANINGFUL_CODE', 'NO_MEANINGFUL_CODE', null]);
      // The one available slot goes to the function after the two meaningless candidates.
      expect(result.targets.map((target) => target.preferredRange)).toEqual([{ startLine: 5, endLine: 7 }]);
    });

    it('excludes a statement that cannot be offered whole', async () => {
      const result = await validateSample([unitCandidate([{ startLine: 10, endLine: 79 }])], { maxLinesPerCandidate: 60 });
      expect(result.trace[0]).toMatchObject({ selected: false, exclusionReason: 'PARTIAL_STATEMENT', candidateStartLine: 10, candidateEndLine: 79, selectedStartLine: null });
      expect(result.targets).toEqual([]);
    });

    it('selects the whole function when it partly overlaps a supplied slice, never only the rest of it', async () => {
      const result = await validateSample([unitCandidate([{ startLine: 5, endLine: 7 }])], { supplied: [{ startLine: 6, endLine: 6 }] });
      expect(result.targets[0]!.preferredRange).toEqual({ startLine: 5, endLine: 7 });
      expect(result.trace[0]).toMatchObject({ selected: true, selectedStartLine: 5, selectedEndLine: 7, lineCount: 3 });
    });

    it('skips the comment before a function and selects the function', async () => {
      const result = await validateSample([unitCandidate([{ startLine: 1, endLine: 4 }, { startLine: 5, endLine: 7 }])]);
      expect(result.targets[0]!.preferredRange).toEqual({ startLine: 5, endLine: 7 });
      expect(result.trace[0]).toMatchObject({ candidateStartLine: 1, candidateEndLine: 7, selectedStartLine: 5, selectedEndLine: 7 });
    });

    it('marks a candidate whose statements are all supplied as ALREADY_COVERED, and one held by another target as DUPLICATE', async () => {
      const result = await validateSample([
        unitCandidate([{ startLine: 9, endLine: 9 }]),
        unitCandidate([{ startLine: 5, endLine: 7 }]),
        unitCandidate([{ startLine: 5, endLine: 7 }], { context: 'ACTION' }),
      ]);
      expect(result.trace.map((entry) => entry.exclusionReason)).toEqual(['ALREADY_COVERED', null, 'DUPLICATE']);
      expect(result.contextsByTarget.get('context-target-001')).toEqual(['G1__LINK', 'G1__ACTION']);
    });

    it('never cuts a statement to fit the line budget', async () => {
      const result = await validateSample([unitCandidate([{ startLine: 5, endLine: 7 }])], { remainingLines: 2 });
      expect(result.trace[0]).toMatchObject({ selected: false, exclusionReason: 'LINE_BUDGET_EXCEEDED' });
      expect(result.targets).toEqual([]);
    });
  });

  describe('what each kind offers', () => {
    it('offers only the declarations the covered lines actually use', () => {
      const links = analyzeFileLinks(['const used = 1;', 'const unrelated = 2;', 'send(used);'].join('\n'), [{ startLine: 3, endLine: 3 }]);
      expect(links.definitions).toEqual([{ startLine: 1, endLine: 1, symbol: 'used' }]);
    });

    it('offers the export a used import names, not the rest of the module', async () => {
      const candidates = await candidatesFor({
        'main.js': ["const { pick } = require('./lib');", 'pick(1);'],
        'lib.js': ['function other() { return 0; }', 'function pick(value) { return value; }', 'module.exports = { other, pick };'],
      }, 'main.js', 2, [['INPUT', 'MISSING']]);
      expect(describeCandidates(candidates)).toEqual(['INPUT MISSING 1 SAME_FILE_DEFINITION main.js:1-1 pick', 'INPUT MISSING 1 STATIC_IMPORT lib.js:2-3 pick']);
      expect(candidates[1]!.units).toEqual([{ startLine: 2, endLine: 2, symbol: 'pick' }, { startLine: 3, endLine: 3, symbol: 'pick' }]);
    });

    it('offers the default export and the declaration it names', async () => {
      const candidates = await candidatesFor({
        'main.js': ["const collect = require('./collect');", 'send(collect());'],
        'collect.js': ["'use strict';", '', '// collector', 'function collect() {', '  return 1;', '}', '', 'module.exports = collect;'],
      }, 'main.js', 2, [['INPUT', 'MISSING']]);
      expect(describeCandidates(candidates).at(-1)).toBe('INPUT MISSING 1 STATIC_IMPORT collect.js:4-8 default');
      expect(candidates.at(-1)!.units.map((unit) => `${unit.startLine}-${unit.endLine}`)).toEqual(['4-6', '8-8']);
    });

    it('offers a named ES export', async () => {
      const candidates = await candidatesFor({
        'main.mjs': ["import { a } from './esm.mjs';", 'a();'],
        'esm.mjs': ['export function a() { return 1; }', 'export const b = 2;'],
      }, 'main.mjs', 2, [['INPUT', 'MISSING']]);
      expect(describeCandidates(candidates)).toContain('INPUT MISSING 1 STATIC_IMPORT esm.mjs:1-1 a');
    });

    it('falls back to the export statements when the imported name is not known, and to the trimmed file when it does not parse', async () => {
      const namespace = await candidatesFor({
        'main.mjs': ["import * as ns from './ns.mjs';", 'ns.run();'],
        'ns.mjs': ['const hidden = 0;', 'export function run() { return hidden; }', 'export const flag = true;'],
      }, 'main.mjs', 2, [['INPUT', 'MISSING']]);
      expect(namespace.find((candidate) => candidate.kind === 'STATIC_IMPORT')).toMatchObject({ filePath: 'ns.mjs', startLine: 2, endLine: 3, statementAligned: true });
      expect(namespace.find((candidate) => candidate.kind === 'STATIC_IMPORT')!.symbol).toBeUndefined();

      const broken = await candidatesFor({
        'main.js': ["const b = require('./broken');", 'b();'],
        'broken.js': ['// broken module', 'module.exports = function ( {', '  return 1;', '// end'],
      }, 'main.js', 2, [['INPUT', 'MISSING']]);
      expect(broken.find((candidate) => candidate.kind === 'STATIC_IMPORT')).toMatchObject({ filePath: 'broken.js', startLine: 2, endLine: 3, statementAligned: false });
    });

    it('offers what a lifecycle script runs at load time and the declarations it uses, not unrelated code', async () => {
      const candidates = await candidatesFor({
        'main.js': ['send(1);'],
        'setup.js': [
          "const os = require('os');", 'function unused() { return 0; }', 'function report(value) { return value; }', 'const host = os.hostname();', 'report(host);',
        ],
      }, 'main.js', 1, [['TRIGGER', 'MISSING']], { scripts: { postinstall: 'node setup.js' } });
      expect(describeCandidates(candidates)).toEqual(['TRIGGER MISSING 1 LIFECYCLE_ENTRY setup.js:1-5']);
      // `unused` (line 2) is not offered; the span only reaches across it.
      expect(candidates[0]!.units.map((unit) => `${unit.startLine}${unit.executable ? '*' : ''}`)).toEqual(['1', '3', '4*', '5*']);
    });

    it('keeps the new statements of another lifecycle file', async () => {
      const files = {
        'install.js': ['send(1);'],
        'setup.js': ["const https = require('https');", "const target = 'https://example.test/x';", 'https.get(target);', 'console.log(target);'],
      };
      const partly = await runOn(files, 'install.js', 1, { TRIGGER: MISSING }, POLICY, { scripts: { postinstall: 'node setup.js' } });
      // Lines 3-4 run at load time; the declarations they use come before them in the same run.
      expect(describeTrace(partly.trace)).toEqual(['1 LIFECYCLE_ENTRY setup.js:1-4 -> 1-4']);
    });

    it('drops a lifecycle file whose statements are all supplied already', async () => {
      const input = projectExecution(await project({ 'install.js': ['send(1);'], 'setup.js': ['console.log(1);', 'console.log(2);'] }), 'install.js', 1, { scripts: { postinstall: 'node setup.js' } });
      const built = await build(input);
      const [slice] = built.input.initialCodeSlices;
      // setup.js lines 1-2 are already in the slices.
      const slices = [slice!, { ...slice!, sliceId: 'SLICE-SETUP', filePath: 'setup.js', startLine: 1, endLine: 2 }];
      const [group] = buildFindingGroups(input, slices);
      const candidates = await generateExpansionCandidates({
        unresolved: [{ group: group!, context: 'TRIGGER', state: 'MISSING' }], slices, resolver: input.artifacts, packageContext: input.packageContext,
        maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
      });
      const result = await validateExpansionCandidates({
        candidates, groups: [group!], slices, resolver: input.artifacts, analysisMode: 'ORIGINAL_ONLY', remainingSlices: 9, remainingLines: 120,
        maxFileSizeBytes: POLICY.codeSlices.maxFileSizeBytes,
      });
      expect(describeTrace(result.trace)).toEqual(['1 LIFECYCLE_ENTRY setup.js:1-2 ALREADY_COVERED']);
      expect(result.targets).toEqual([]);
    });
  });

  describe('candidate order', () => {
    it('orders TRIGGER candidates lifecycle first, then entry point', async () => {
      const candidates = await candidatesFor({
        'main.js': ['send(1);'], 'setup.js': ['console.log(1);'], 'entry.js': ['console.log(2);'],
      }, 'main.js', 1, [['TRIGGER', 'MISSING']], { scripts: { postinstall: 'node setup.js' }, main: 'entry.js' });
      expect(candidates.map((candidate) => candidate.filePath)).toEqual(['setup.js', 'entry.js']);
    });

    it('orders ACTION candidates of a LIFECYCLE group: local function, lifecycle file, used import', async () => {
      const candidates = await candidatesFor({
        'main.js': ["const helper = require('./helper');", 'function act() { return 1; }', 'act(helper());'],
        'helper.js': ['module.exports = function () { return 2; };'],
        'setup.js': ['console.log(3);'],
      }, 'main.js', 3, [['ACTION', 'PARTIAL']], { ruleId: 'custom.lifecycle-entry', scripts: { postinstall: 'node setup.js' } });
      expect(candidates.map((candidate) => candidate.kind)).toEqual(['LOCAL_FUNCTION', 'LIFECYCLE_ENTRY', 'STATIC_IMPORT']);
    });

    it('orders LINK candidates: definition, local function, used import', async () => {
      const candidates = await candidatesFor({
        'main.js': ["const helper = require('./helper');", 'function act() { return 1; }', 'const value = 2;', 'send(act(value), helper);'],
        'helper.js': ['module.exports = { ready: true };'],
      }, 'main.js', 4, [['LINK', 'PARTIAL']]);
      expect(candidates.map((candidate) => candidate.kind)).toEqual(['SAME_FILE_DEFINITION', 'SAME_FILE_DEFINITION', 'LOCAL_FUNCTION', 'STATIC_IMPORT']);
    });

    it('orders MISSING first hops, then MISSING second hops, then PARTIAL first hops', async () => {
      const candidates = await candidatesFor(LINK_PROJECT, 'main.js', 7, [['INPUT', 'PARTIAL'], ['ACTION', 'MISSING'], ['LINK', 'MISSING']]);
      const tags = candidates.map((candidate) => `${candidate.state} ${candidate.depth}`);
      const firstSecond = tags.indexOf('MISSING 2');
      const firstPartial = tags.indexOf('PARTIAL 1');
      expect(firstSecond).toBeGreaterThan(-1);
      expect(firstPartial).toBeGreaterThan(firstSecond);
      expect(tags.slice(0, firstSecond).every((tag) => tag === 'MISSING 1')).toBe(true);
      expect(tags.slice(firstSecond, firstPartial).every((tag) => tag === 'MISSING 2')).toBe(true);
      expect(tags.slice(firstPartial).every((tag) => tag === 'PARTIAL 1')).toBe(true);
    });
  });

  describe('TRIGGER evidence', () => {
    it('does not offer the group\'s own file as TRIGGER evidence when a lifecycle command runs it, and frees the slot', async () => {
      const files = {
        'install.js': ["const https = require('https');", "https.get('https://example.test/x');", 'console.log(1);'],
        'entry.js': ["require('./install');"],
      };
      // Two INITIAL slices allowed: one is used, one is left for the expansion.
      const oneSlot = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxInitialSlices: 2 } };
      const { outcome, trace } = await runOn(files, 'install.js', 2, { TRIGGER: MISSING }, oneSlot, { scripts: { postinstall: 'node install.js' }, main: 'entry.js' });
      expect(describeTrace(trace)).toEqual([
        '1 LIFECYCLE_ENTRY install.js:1-3 SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE',
        // The entry point is still offered and takes the slot the excluded candidate did not use.
        '1 LIFECYCLE_ENTRY entry.js:1-1 -> 1-1',
      ]);
      expect(trace[0]).toMatchObject({ selected: false, lineCount: 3, selectedStartLine: null });
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', addedTargetCount: 1, addedLineCount: 1 });
    });

    it('keeps another lifecycle file as TRIGGER evidence', async () => {
      const files = { 'install.js': ['send(1);'], 'setup.js': ['console.log(2);'] };
      const { trace } = await runOn(files, 'install.js', 1, { TRIGGER: MISSING }, POLICY, { scripts: { postinstall: 'node install.js && node setup.js' } });
      expect(describeTrace(trace)).toEqual([
        '1 LIFECYCLE_ENTRY install.js:1-1 SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE',
        '1 LIFECYCLE_ENTRY setup.js:1-1 -> 1-1',
      ]);
    });

    it('leaves TRIGGER missing when nothing but the group\'s own file is run', async () => {
      const files = { 'install.js': ["const https = require('https');", 'const request = https.request(url);', 'request.end();'] };
      const { outcome } = await runOn(files, 'install.js', 2, { TRIGGER: MISSING }, POLICY, { scripts: { postinstall: 'node install.js' } });
      expect(outcome.record).toMatchObject({ status: 'NO_CANDIDATE', unresolvedContextCount: 1 });
      expect(outcome.built.input.missingData.filter((item) => item.field === 'contextCheck').map((item) => item.reason)).toEqual([
        'install.js (NETWORK_SEND): TRIGGER context is MISSING in the supplied slices; the postinstall script runs this file directly; the flagged code runs when the file is loaded; no other caller or entry point was found.',
      ]);
      // The state is the model's; the lifecycle fact is shown to it, never turned into VISIBLE.
      expect(outcome.record.states.find((item) => item.context === 'TRIGGER')).toMatchObject({ state: 'MISSING' });
    });

    it('still lets the same statements serve ACTION for a LIFECYCLE group', async () => {
      const files = { 'install.js': ["const https = require('https');", 'const request = https.request(url);', 'request.end();'] };
      const { trace } = await runOn(files, 'install.js', 2, { TRIGGER: MISSING, ACTION: MISSING }, POLICY, { ruleId: 'custom.lifecycle-entry', scripts: { postinstall: 'node install.js' } });
      expect(describeTrace(trace)).toEqual([
        '1 LIFECYCLE_ENTRY install.js:1-3 SELF_LIFECYCLE_FILE_NOT_TRIGGER_EVIDENCE',
        // `request.end()` (line 3) runs at load time and is what the installed code does.
        '1 LIFECYCLE_ENTRY install.js:1-3 -> 3-3',
      ]);
      expect(trace.map((entry) => entry.context)).toEqual(['TRIGGER', 'ACTION']);
    });
  });

  describe('TRIGGER resolution', () => {
    const triggerNotes = (outcome: Awaited<ReturnType<typeof runOn>>['outcome']) => outcome.built.input.missingData
      .filter((item) => item.field === 'contextCheck' && item.reason.includes('TRIGGER context')).map((item) => item.reason);
    const SEND = { 'send.js': ["const https = require('https');", 'function send(data) {', '  https.request(data).end();', '}', 'module.exports = { send };'] };
    const CHAIN = {
      ...SEND,
      'runner.js': ["const { send } = require('./send');", '', 'function start() {', "  send({ host: 'x' });", '}', '', 'module.exports = { start };'],
      'setup.js': ["const { start } = require('./runner');", '', 'start();'],
    };
    const POSTINSTALL = { scripts: { postinstall: 'node setup.js' } };

    it('resolves TRIGGER when a lifecycle file requires the group\'s file', async () => {
      const files = { ...SEND, 'setup.js': ["const { send } = require('./send');", "send({ host: 'x' });"] };
      const { outcome, trace } = await runOn(files, 'send.js', 3, { TRIGGER: MISSING }, POLICY, POSTINSTALL);
      expect(describeTrace(trace)).toEqual(['1 LIFECYCLE_ENTRY setup.js:1-2 -> 1-2']);
      expect(triggerNotes(outcome)).toEqual([]);
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 0 });
    });

    it('resolves TRIGGER through a side-effect require of the group\'s file', async () => {
      const files = { ...SEND, 'setup.js': ["require('./send');"] };
      const { outcome } = await runOn(files, 'send.js', 3, { TRIGGER: MISSING }, POLICY, POSTINSTALL);
      expect(triggerNotes(outcome)).toEqual([]);
    });

    it('follows a MISSING TRIGGER through one imported function to the group\'s file', async () => {
      const { outcome, trace } = await runOn(CHAIN, 'send.js', 3, { TRIGGER: MISSING }, POLICY, POSTINSTALL);
      // setup.js calls start; start's definition in runner.js requires send.js (line 1), so both are shown.
      expect(describeTrace(trace)).toEqual(['1 LIFECYCLE_ENTRY setup.js:1-3 -> 1-3', '2 STATIC_IMPORT runner.js:1-7 -> 1-7']);
      expect(triggerNotes(outcome)).toEqual([]);
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 0 });
    });

    it('takes PARTIAL TRIGGER to the first hop only, so a path through another module stays unresolved', async () => {
      const { outcome, trace } = await runOn(CHAIN, 'send.js', 3, { TRIGGER: { score: 1, confidence: 1 } }, POLICY, POSTINSTALL);
      expect(describeTrace(trace)).toEqual(['1 LIFECYCLE_ENTRY setup.js:1-3 -> 1-3']);
      expect(triggerNotes(outcome)).toEqual([
        'send.js (NETWORK_SEND): TRIGGER context was PARTIAL at the first check; the flagged code is in a function that is exported and not called in this file; code was added afterwards and not rated again, so whether it settles this is not established.',
      ]);
    });

    it('offers no second hop when the called function does not reach the group\'s file', async () => {
      const files = { ...CHAIN, 'runner.js': ['function start() {', '  console.log(1);', '}', 'module.exports = { start };'] };
      const { outcome, trace } = await runOn(files, 'send.js', 3, { TRIGGER: MISSING }, POLICY, POSTINSTALL);
      expect(trace.some((entry) => entry.depth === 2)).toBe(false);
      expect(triggerNotes(outcome)).toEqual([
        'send.js (NETWORK_SEND): TRIGGER context was MISSING at the first check; the flagged code is in a function that is exported and not called in this file; code was added afterwards and not rated again, so whether it settles this is not established.',
      ]);
    });

    it('does not take the group\'s own file as TRIGGER evidence when it is the main entry point', async () => {
      const files = { 'index.js': ["const https = require('https');", 'https.request(url).end();'] };
      const { outcome, trace } = await runOn(files, 'index.js', 2, { TRIGGER: MISSING }, POLICY, { main: './index' });
      expect(describeTrace(trace)).toEqual(['1 LIFECYCLE_ENTRY index.js:1-1 SELF_ENTRY_FILE_NOT_TRIGGER_EVIDENCE']);
      expect(triggerNotes(outcome)).toEqual([
        'index.js (NETWORK_SEND): TRIGGER context is MISSING in the supplied slices; this file is the package MAIN entry point; the flagged code runs when the file is loaded; no other caller or entry point was found.',
      ]);
      expect(outcome.record.states.find((item) => item.context === 'TRIGGER')).toMatchObject({ state: 'MISSING' });
    });

    it('shows the main entry point fact to the model', async () => {
      const input = projectExecution(await project({ 'index.js': ['send(1);'] }), 'index.js', 1, { main: './index' });
      const slices = (await build(input)).input.initialCodeSlices;
      const request = buildContextCheckRequest(input, slices, buildFindingGroups(input, slices));
      expect((request.state as { groups: unknown[] }).groups[0]).toMatchObject({ runAsEntryPoint: ['MAIN'] });
      expect((request.state as { groups: unknown[] }).groups[0]).not.toHaveProperty('runByLifecycle');
    });

    it('counts a path as shown only when every line of its statements is in a slice', () => {
      const base = { groupId: 'G1', context: 'TRIGGER' as const, state: 'MISSING' as const, artifactId: ARTIFACT, statementAligned: true };
      const definition: ExpansionCandidate = {
        ...base, depth: 2, kind: 'STATIC_IMPORT', filePath: 'runner.js', startLine: 1, endLine: 7, symbol: 'start',
        units: [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 5 }, { startLine: 7, endLine: 7 }], triggerSource: 'DIRECT', triggerUnit: { startLine: 1, endLine: 1 },
      };
      const caller: ExpansionCandidate = {
        ...base, depth: 1, kind: 'LIFECYCLE_ENTRY', filePath: 'setup.js', startLine: 1, endLine: 3,
        units: [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3, executable: true }], triggerSource: 'CALL', triggerUnit: { startLine: 3, endLine: 3 }, dependsOn: candidateKey(definition),
      };
      const slice = (filePath: string, startLine: number, endLine: number) => ({ artifactId: ARTIFACT, filePath, startLine, endLine }) as AgentCodeSlice;
      const setup = slice('setup.js', 1, 3);
      expect(groupsWithUnresolvedTrigger([caller, definition], [setup, slice('runner.js', 1, 7)])).toEqual(new Set());
      // Two slices that together hold every line count as shown.
      expect(groupsWithUnresolvedTrigger([caller, definition], [setup, slice('runner.js', 1, 3), slice('runner.js', 4, 7)])).toEqual(new Set());
      // module.exports (line 7) is cut off.
      expect(groupsWithUnresolvedTrigger([caller, definition], [setup, slice('runner.js', 1, 5)])).toEqual(new Set(['G1']));
      // The call itself is not shown.
      expect(groupsWithUnresolvedTrigger([caller, definition], [slice('setup.js', 1, 1), slice('runner.js', 1, 7)])).toEqual(new Set(['G1']));
    });
  });

  describe('execution path to a Finding', () => {
    const at = (lines: string[], line: number) => executionPathTo(lines.join('\n'), { startLine: line, endLine: line });
    const kinds = (lines: string[], line: number) => at(lines, line).steps.map((step) => `${step.kind}${step.symbol ? `:${step.symbol}` : ''}@${step.line ?? '?'}`);

    it('finds code that runs at the top level, also behind a top-level condition', () => {
      expect(at(['run(1);'], 1)).toEqual({ position: 'TOP_LEVEL', steps: [] });
      expect(at(['if (process.platform === "win32") {', '  run(1);', '}'], 2).position).toBe('TOP_LEVEL');
      // A callback that starts on the Finding's line and runs on: the Finding is the call that holds it.
      expect(at(['get(url, (res) => {', '  run(res);', '});'], 1).position).toBe('TOP_LEVEL');
    });

    it('follows named and immediate calls from the top level', () => {
      const named = ['function main() {', '  run(1);', '}', 'main();'];
      expect(at(named, 2)).toEqual({ position: 'CALLED_AT_LOAD', steps: [{ kind: 'CALL', symbol: 'main', line: 4, statement: { startLine: 4, endLine: 4 }, definition: { startLine: 1, endLine: 3 } }] });
      const chain = ['const start = () => {', '  inner();', '};', 'function inner() {', '  run(1);', '}', 'start();'];
      expect(kinds(chain, 5)).toEqual(['CALL:start@7', 'CALL:inner@2']);
      expect(at(chain, 5).position).toBe('CALLED_AT_LOAD');
      const immediate = ['(async () => {', '  run(1);', '})();'];
      expect(at(immediate, 2)).toEqual({ position: 'CALLED_AT_LOAD', steps: [{ kind: 'IMMEDIATE_CALL', line: 1, definition: { startLine: 1, endLine: 3 } }] });
      // A one-line function holds the Finding on its line.
      expect(at(['function main() { run(1); }', 'main();'], 1).position).toBe('CALLED_AT_LOAD');
    });

    it('reports the condition, loop or try block a call is made in', () => {
      const conditional = ['function main() {', '  run(1);', '}', 'if (process.env.CI) {', '  main();', '}'];
      expect(at(conditional, 2)).toEqual({ position: 'CALLED_AT_LOAD', steps: [{
        kind: 'CALL', symbol: 'main', line: 5, statement: { startLine: 5, endLine: 5 }, within: { startLine: 4, endLine: 6, kind: 'CONDITION' }, definition: { startLine: 1, endLine: 3 },
      }] });
      const tried = ['function main() {', '  run(1);', '}', 'try {', '  main();', '} catch (error) {}'];
      expect(at(tried, 2).steps[0]).toMatchObject({ within: { startLine: 4, endLine: 6, kind: 'TRY' } });
      // `require.main === module` with the call in its true branch is told apart: it holds when the file is run as a script.
      const direct = (test: string, call = '  main();', other = '') => ['function main() {', '  run(1);', '}', `if (${test}) {`, call, '} else {', other, '}'];
      expect(at(direct('require.main === module'), 2).steps[0]).toMatchObject({ within: { startLine: 4, endLine: 8, kind: 'RUN_DIRECTLY' } });
      expect(at(direct('module === require.main'), 2).steps[0]).toMatchObject({ within: { kind: 'RUN_DIRECTLY' } });
      // In the else branch, or with anything more in the test, it is an ordinary condition.
      expect(at(direct('require.main === module', '', '  main();'), 2).steps[0]).toMatchObject({ within: { kind: 'CONDITION' } });
      expect(at(direct('require.main === module && ready'), 2).steps[0]).toMatchObject({ within: { kind: 'CONDITION' } });
      expect(at(direct('require.main !== module'), 2).steps[0]).toMatchObject({ within: { kind: 'CONDITION' } });
      // A call that is a statement of its own at the top level has no enclosing statement.
      expect(at(['function main() {', '  run(1);', '}', 'main();'], 2).steps[0]).not.toHaveProperty('within');
      // Inside a function, the enclosing statement is looked for in that function only.
      const nested = ['function inner() {', '  run(1);', '}', 'function outer() {', '  for (const item of list) {', '    inner();', '  }', '}', 'outer();'];
      expect(at(nested, 2).steps).toMatchObject([{ kind: 'CALL', symbol: 'outer', line: 9 }, { kind: 'CALL', symbol: 'inner', line: 6, within: { startLine: 5, endLine: 7, kind: 'LOOP' } }]);
      expect(at(nested, 2).steps[0]).not.toHaveProperty('within');
    });

    it('keeps a callback as registered only, whether inline or passed by name', () => {
      const inline = ['https.get(url, (res) => {', '  run(res);', '});'];
      expect(at(inline, 2)).toMatchObject({ position: 'CALLBACK', steps: [{ kind: 'CALLBACK_REGISTRATION', symbol: 'https.get', line: 1, statement: { startLine: 1, endLine: 3 } }] });
      const byName = ['function onData(chunk) {', '  run(chunk);', '}', 'stream.on("data", onData);'];
      expect(at(byName, 2)).toMatchObject({ position: 'CALLBACK', steps: [{ kind: 'CALLBACK_REGISTRATION', symbol: 'stream.on', line: 4, statement: { startLine: 4, endLine: 4 }, definition: { startLine: 1, endLine: 3 } }] });
      // Registered inside a function that is called at load: still only registered.
      const nested = ['function main() {', '  setTimeout(() => {', '    run(1);', '  }, 10);', '}', 'main();'];
      expect(kinds(nested, 3)).toEqual(['CALL:main@6', 'CALLBACK_REGISTRATION:setTimeout@2']);
      expect(at(nested, 3).position).toBe('CALLBACK');
    });

    it('does not take an exported function as run', () => {
      expect(at(['function send() {', '  run(1);', '}', 'module.exports = { send };'], 2)).toEqual({ position: 'EXPORTED_NOT_CALLED', steps: [{ kind: 'EXPORT', symbol: 'send', line: 1 }] });
      expect(at(['exports.send = function () {', '  run(1);', '};'], 2).position).toBe('EXPORTED_NOT_CALLED');
      expect(at(['export function send() {', '  run(1);', '}'], 2).position).toBe('EXPORTED_NOT_CALLED');
      // A call from inside another function that is itself only exported does not run it either.
      expect(at(['function inner() {', '  run(1);', '}', 'function outer() {', '  inner();', '}', 'module.exports = outer;'], 2).position).toBe('EXPORTED_NOT_CALLED');
      // Exported and called: the call counts.
      expect(at(['function send() {', '  run(1);', '}', 'module.exports = { send };', 'send();'], 2).position).toBe('CALLED_AT_LOAD');
    });

    it('leaves methods, dynamic calls, uncalled functions and unreadable files unknown', () => {
      expect(at(['class A {', '  m() {', '    run(1);', '  }', '}', 'new A().m();'], 3).position).toBe('UNKNOWN');
      expect(at(['const table = { go() {', '  run(1);', '} };', 'table[name]();'], 2).position).toBe('UNKNOWN');
      expect(at(['function never() {', '  run(1);', '}'], 2).position).toBe('UNKNOWN');
      expect(at(['const handlers = {};', 'handlers.go = function () {', '  run(1);', '};', 'handlers[key]();'], 3).position).toBe('UNKNOWN');
      expect(at(['function a() {', '  b();', '  run(1);', '}', 'function b() {', '  a();', '}'], 3).position).toBe('UNKNOWN');
      // An alias and a function that only calls itself are not followed.
      expect(at(['function send() {', '  run(1);', '}', 'const go = send;', 'go();'], 2).position).toBe('UNKNOWN');
      expect(at(['function loop() {', '  run(1);', '  loop();', '}'], 2).position).toBe('UNKNOWN');
      expect(at(['const = ;', 'run(1);'], 2).position).toBe('UNKNOWN');
      expect(at(['run(1);'], 9).position).toBe('UNKNOWN');
    });

    it('finds the complete statement a Finding line belongs to', () => {
      const code = ['connect(port, host, () => {', '  spawn(shell);', '});', 'function send() {', '  run(1);', '}'].join('\n');
      // A statement that starts on the Finding line is taken whole.
      expect(findingStatement(code, { startLine: 1, endLine: 1 })).toEqual({ startLine: 1, endLine: 3 });
      expect(findingStatement(code, { startLine: 2, endLine: 2 })).toEqual({ startLine: 2, endLine: 2 });
      expect(findingStatement(code, { startLine: 5, endLine: 5 })).toEqual({ startLine: 5, endLine: 5 });
      expect(findingStatement(code, { startLine: 9, endLine: 9 })).toBeUndefined();
      expect(findingStatement('const = ;', { startLine: 1, endLine: 1 })).toBeUndefined();
    });

    it('takes the least certain position of a group', () => {
      expect(weakestPosition(['TOP_LEVEL', 'CALLBACK', 'CALLED_AT_LOAD'])).toBe('CALLBACK');
      expect(weakestPosition(['TOP_LEVEL', 'CALLED_AT_LOAD'])).toBe('CALLED_AT_LOAD');
      expect(weakestPosition(['EXPORTED_NOT_CALLED', 'UNKNOWN'])).toBe('UNKNOWN');
      expect(weakestPosition([])).toBe('UNKNOWN');
    });
  });

  describe('execution evidence in the request', () => {
    const POSTINSTALL = { scripts: { postinstall: 'node install.js' } };
    const CALLED = { 'install.js': ["const https = require('https');", 'function send() {', '  https.request(url).end();', '}', 'send();'] };
    const CALLBACK = { 'install.js': ["const https = require('https');", 'https.get(url, (res) => {', '  exec(res);', '});'] };
    const EXPORTED = { 'install.js': ['function send() {', '  https.request(url).end();', '}', 'module.exports = { send };'] };
    type Group = { runByLifecycle?: string[]; findings: Array<{ startLine: number | null; execution?: { position: string; steps: unknown[]; source: string } }> };
    const OTHER_QUESTIONS = ['G1__INPUT', 'G1__ACTION', 'G1__TARGET', 'G1__LINK'];

    async function runEvidence(
      files: Record<string, string[]>, line: number, mode?: TriggerEvidenceMode, change?: (input: Tier3ExecutionInput) => void,
      answers: Partial<Record<string, ScoreAnswer>> = {}, policy = POLICY,
    ) {
      const input = projectExecution(await project(files), 'install.js', line, POSTINSTALL);
      change?.(input);
      const built = await build(input, undefined, policy);
      const jev = provider(answers);
      const trace: CandidateTraceEntry[] = [];
      const outcome = await runContextCheck({
        enabled: true, provider: jev, execution: input, built, policy: policy.codeSlices, rebuild: (expanded, supplement) => build(expanded, supplement, policy),
        onCandidateTrace: (entries) => trace.push(...entries),
        ...(mode === undefined ? {} : { triggerEvidence: mode }),
      });
      const request = jev.check.mock.calls[0]![0];
      return { outcome, request, built, trace, group: (request.state as { groups: Group[] }).groups[0]!, trigger: request.questions.G1__TRIGGER!.instructions };
    }
    const added = (run: Awaited<ReturnType<typeof runEvidence>>) => run.outcome.built.input.initialCodeSlices.slice(run.built.input.initialCodeSlices.length)
      .map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`);

    it('writes each Finding position and path into the TRIGGER question, not into the shared state', async () => {
      const { outcome, request, group, trigger } = await runEvidence(CALLED, 3, 'INSTRUCTION');
      expect(group.runByLifecycle).toEqual(['postinstall']);
      expect(group.findings[0]).not.toHaveProperty('execution');
      expect(trigger).toContain('`install.js` is run directly by the postinstall lifecycle script.');
      expect(trigger).toContain('Finding line 3 [CALLED_AT_LOAD] reached from the file load through the call to send() at line 5 (its function is lines 2-4); '
        + 'every step is a direct call, so this code runs when the file is loaded.');
      expect(trigger).toContain('For this group the call chain from the file load to the flagged code is confirmed.');
      expect(trigger).toContain('A CALLBACK is code handed to a timer, an event or an API');
      expect(trigger).not.toContain('are supplied in `slices`');
      // The criteria of the question are unchanged.
      expect(request.questions.G1__TRIGGER!.criteria).toEqual([...QUESTION_TEMPLATES.NETWORK_SEND.TRIGGER.criteria]);
      expect(outcome.record.executionEvidence).toEqual([{
        groupId: 'G1', filePath: 'install.js', behavior: 'NETWORK_SEND', runByLifecycle: ['postinstall'], runAsEntryPoint: [], position: 'CALLED_AT_LOAD',
        findings: [{
          findingId: FINDING, ruleId: 'custom.network-outbound', startLine: 3, statement: { startLine: 3, endLine: 3 }, position: 'CALLED_AT_LOAD',
          steps: [{ kind: 'CALL', symbol: 'send', line: 5, statement: { startLine: 5, endLine: 5 }, definition: { startLine: 2, endLine: 4 } }],
        }],
      }]);
    });

    it('leaves state and every question other than TRIGGER exactly as they are without the evidence', async () => {
      const none = await runEvidence(CALLED, 3, 'NONE');
      type State = { slices: Array<{ sliceId: string; code: string }> };
      const withoutPathSlices = (state: unknown) => ({ ...(state as State), slices: (state as State).slices.filter((slice) => !slice.sliceId.startsWith('EXECUTION-PATH-')) });
      for (const mode of ['INSTRUCTION', 'INSTRUCTION_WITH_PATH', undefined] as const) {
        const withEvidence = await runEvidence(CALLED, 3, mode);
        // No execution evidence is in state. The only difference a path statement makes is its own slice, which the Agent is given too.
        expect(withoutPathSlices(withEvidence.request.state)).toEqual(none.request.state);
        expect((withEvidence.request.state as State).slices.filter((slice) => slice.sliceId.startsWith('EXECUTION-PATH-')).map((slice) => slice.code))
          .toEqual(mode === 'INSTRUCTION' ? [] : ['send();']);
        expect(JSON.stringify(withEvidence.request.state)).not.toContain('CALLED_AT_LOAD');
        expect(Object.keys(withEvidence.request.questions)).toEqual(Object.keys(none.request.questions));
        for (const key of OTHER_QUESTIONS) expect(withEvidence.request.questions[key]).toEqual(none.request.questions[key]);
        expect(withEvidence.trigger).not.toBe(none.trigger);
        expect(withEvidence.trigger.startsWith(none.trigger)).toBe(true);
      }
      // The measurement modes that put the evidence in state do change what the other questions see.
      const inState = await runEvidence(CALLED, 3, 'STATE_AND_INSTRUCTION');
      expect(inState.request.state).not.toEqual(none.request.state);
      expect(inState.group.findings[0]!.execution).toEqual({ position: 'CALLED_AT_LOAD', steps: [{ kind: 'CALL', symbol: 'send', line: 5 }], source: 'SCANNER_STATIC_ANALYSIS' });
      expect(inState.trigger).toContain('findings[*].execution');
      const stateOnly = await runEvidence(CALLED, 3, 'STATE');
      expect(stateOnly.group.findings[0]!.execution).toMatchObject({ position: 'CALLED_AT_LOAD' });
      expect(stateOnly.trigger).toBe(none.trigger);
    });

    it('adds the call site the slices lack as a slice and quotes it in the TRIGGER question', async () => {
      const run = await runEvidence(CALLED, 3);
      // The slice holds line 3 only; `send();` on line 5 is the confirmed call from the top level.
      expect(run.trigger).toContain('These statements of `install.js` are supplied in `slices`: slice `EXECUTION-PATH-1`, lines 5-5 (call site).');
      // The model rates what is in slices, so the statement is a slice of the request, exactly as the Agent will get it.
      expect((run.request.state as { slices: unknown[] }).slices.at(-1)).toEqual({ sliceId: 'EXECUTION-PATH-1', filePath: 'install.js', representation: 'ORIGINAL', startLine: 5, endLine: 5, code: 'send();' });
      expect(run.trigger).not.toContain('send();');
      expect(added(run)).toEqual(['install.js:5-5']);
      expect(run.outcome.built.input.analysisPlan.targets.at(-1)!.reasonCodes).toEqual(['CONTEXT_EXPANSION', 'CONTEXT_TRIGGER', 'EXECUTION_PATH']);
      expect(run.outcome.record.executionPathStatements).toEqual([{ groupId: 'G1', filePath: 'install.js', startLine: 5, endLine: 5, purpose: 'CALL_SITE' }]);
      expect(run.trace.map((entry) => `${entry.context} ${entry.kind} ${entry.candidateStartLine}-${entry.candidateEndLine} ${entry.selected}`)).toEqual(['TRIGGER EXECUTION_PATH 5-5 true']);
      // Every answer was VISIBLE: the statement is still added, because the model was shown it.
      expect(run.outcome.record).toMatchObject({ status: 'EXPANDED', addedTargetCount: 1, addedSliceCount: 1, addedLineCount: 1, unresolvedContextCount: 0 });
      // Nothing of the function body or the rest of the file is added.
      expect(run.outcome.built.input.initialCodeSlices.map((slice) => `${slice.startLine}-${slice.endLine}`)).toEqual(['3-3', '5-5']);
    });

    it('quotes a conditional call together with its condition and says the call depends on it', async () => {
      const files = { 'install.js': ["const https = require('https');", 'function send() {', '  https.request(url).end();', '}', 'if (process.env.CI) {', '  send();', '}'] };
      const run = await runEvidence(files, 3);
      expect(run.trigger).toContain('Finding line 3 [CALLED_AT_LOAD] reached from the file load through the call to send() at line 6, made inside a condition at lines 5-7 (its function is lines 2-4); '
        + 'every step is a direct call, so this code runs when the file is loaded and that condition holds.');
      expect(run.trigger).toContain('slice `EXECUTION-PATH-1`, lines 5-7 (call site).');
      expect((run.request.state as { slices: unknown[] }).slices.at(-1)).toMatchObject({ startLine: 5, endLine: 7, code: 'if (process.env.CI) {\n  send();\n}' });
      expect(added(run)).toEqual(['install.js:5-7']);
      expect(run.outcome.record.executionEvidence[0]).toMatchObject({ position: 'CALLED_AT_LOAD' });
    });

    it('says that require.main === module holds only because a lifecycle script runs the file directly', async () => {
      const files = { 'install.js': ["const https = require('https');", 'function send() {', '  https.request(url).end();', '}', 'if (require.main === module) {', '  send();', '}'] };
      const run = await runEvidence(files, 3);
      expect(run.trigger).toContain('through the call to send() at line 6, made inside the condition `require.main === module` at lines 5-7 (its function is lines 2-4); '
        + 'every step is a direct call, so this code runs when the file is loaded; that condition holds because the postinstall lifecycle script runs this file directly.');
      expect((run.request.state as { slices: unknown[] }).slices.at(-1)).toMatchObject({ startLine: 5, endLine: 7, code: 'if (require.main === module) {\n  send();\n}' });
      // The same file reached only as an entry point is required, not run: the condition is not said to hold.
      const input = projectExecution(await project(files), 'install.js', 3, { main: 'install.js' });
      const slices = (await build(input)).input.initialCodeSlices;
      const groups = buildFindingGroups(input, slices);
      const evidence = run.outcome.record.executionEvidence.map((group) => ({ ...group, runByLifecycle: [], runAsEntryPoint: ['MAIN'] }));
      expect(buildContextCheckRequest(input, slices, groups, { groups: evidence, mode: 'INSTRUCTION' }).questions.G1__TRIGGER!.instructions)
        .toContain('so this code runs when the file is loaded, but only if the file is run directly: that condition does not hold when the file is required.');
    });

    it('keeps the model answer as the state and does not take a path statement as resolving TRIGGER', async () => {
      const partial = await runEvidence(CALLED, 3, undefined, undefined, { TRIGGER: { score: 1, confidence: 1 } });
      expect(partial.outcome.record.states.find((state) => state.context === 'TRIGGER')).toMatchObject({ state: 'PARTIAL', score: 1, confidence: 1 });
      expect(added(partial)).toEqual(['install.js:5-5']);
      expect(partial.outcome.record.unresolvedContextCount).toBe(1);
      expect(partial.outcome.built.input.missingData.filter((item) => item.reason.includes('TRIGGER context')).map((item) => item.reason)).toEqual([
        'install.js (NETWORK_SEND): TRIGGER context is PARTIAL in the supplied slices; the postinstall script runs this file directly; '
        + 'the flagged code is in a function that is called when the file is loaded; no other caller or entry point was found.',
      ]);
      const visible = await runEvidence(CALLED, 3);
      expect(visible.outcome.record.states.find((state) => state.context === 'TRIGGER')).toMatchObject({ state: 'VISIBLE', score: 2 });
    });

    it('adds the statement of a Finding that the slices do not hold', async () => {
      // The slice is line 3; the Finding is moved to line 2, which no slice shows.
      const files = { 'install.js': ["const https = require('https');", 'https.request(url).end();', 'run(2);'] };
      const run = await runEvidence(files, 3, undefined, (input) => {
        input.bindings.findingBindings = input.bindings.findingBindings.map((binding) => ({ ...binding, startLine: 2, endLine: 2 }));
      });
      expect(run.outcome.record.executionEvidence[0]).toMatchObject({ position: 'TOP_LEVEL', findings: [{ startLine: 2, statement: { startLine: 2, endLine: 2 } }] });
      expect(run.trigger).toContain('Finding line 2 [TOP_LEVEL] outside every function, so this statement runs when the file is loaded.');
      expect(run.trigger).toContain('slice `EXECUTION-PATH-1`, lines 2-2 (the Finding statement).');
      // Line 2 comes before the slice of line 3, so its slice is placed before it.
      expect((run.request.state as { slices: Array<{ sliceId: string }> }).slices.map((slice) => slice.sliceId)).toEqual(['EXECUTION-PATH-1', expect.stringMatching(/^SLICE-/u)]);
      expect((run.request.state as { slices: unknown[] }).slices[0]).toMatchObject({ sliceId: 'EXECUTION-PATH-1', startLine: 2, endLine: 2, code: 'https.request(url).end();' });
      expect(added(run)).toEqual(['install.js:2-2']);
      expect(run.outcome.record.executionPathStatements).toEqual([{ groupId: 'G1', filePath: 'install.js', startLine: 2, endLine: 2, purpose: 'FINDING_STATEMENT' }]);
    });

    it('puts a path statement into the request in file order and without the lines another slice already holds', async () => {
      // The Finding statement is lines 2-5; the supplied slice is lines 4-6, so lines 4-5 are already there.
      const files = { 'install.js': ['const a = 1;', 'https.request({', '  host: h,', '  path: p,', '}).end();', 'run(6);'] };
      const run = await runEvidence(files, 5, undefined, (input) => {
        input.validatedPlan.targets[0] = { ...input.validatedPlan.targets[0]!, preferredRange: { startLine: 4, endLine: 6 } };
        input.bindings.findingBindings = input.bindings.findingBindings.map((binding) => ({ ...binding, startLine: 2, endLine: 2 }));
      });
      const slices = (run.request.state as { slices: Array<{ sliceId: string; startLine: number; endLine: number; code: string }> }).slices;
      expect(slices.map((slice) => `${slice.sliceId.startsWith('EXECUTION-PATH-') ? 'PATH' : 'SLICE'} ${slice.startLine}-${slice.endLine}`)).toEqual(['PATH 2-3', 'SLICE 4-6']);
      expect(slices[0]!.code).toBe('https.request({\n  host: h,');
      // No line of the file is in the request twice.
      const lines = slices.flatMap((slice) => Array.from({ length: slice.endLine - slice.startLine + 1 }, (_, index) => slice.startLine + index));
      expect(new Set(lines).size).toBe(lines.length);
      expect(run.trigger).toContain('slice `EXECUTION-PATH-1`, lines 2-3 (the Finding statement, lines 2-5; its other lines are in the neighbouring slices).');
      // The Agent input still gets the whole statement: a statement is never cut there.
      expect(added(run)).toEqual(['install.js:2-5']);
      // The questions other than TRIGGER are worded exactly as without the evidence.
      const none = await runEvidence(files, 5, 'NONE', (input) => {
        input.validatedPlan.targets[0] = { ...input.validatedPlan.targets[0]!, preferredRange: { startLine: 4, endLine: 6 } };
        input.bindings.findingBindings = input.bindings.findingBindings.map((binding) => ({ ...binding, startLine: 2, endLine: 2 }));
      });
      for (const key of OTHER_QUESTIONS) expect(run.request.questions[key]).toEqual(none.request.questions[key]);
    });

    it('offers each missing call site once, skips what the slices hold, and only for groups that ask TRIGGER', () => {
      const step = (line: number) => ({ kind: 'CALL' as const, symbol: 'main', line, statement: { startLine: line, endLine: line }, definition: { startLine: 1, endLine: 6 } });
      const finding = (findingId: string, startLine: number, steps: ExecutionStep[]) => (
        { findingId, ruleId: 'r', startLine, statement: { startLine, endLine: startLine }, position: 'CALLED_AT_LOAD' as const, steps }
      );
      const group = (contexts: ContextCode[]): FindingGroup => ({ groupId: 'G1', artifactId: ARTIFACT, filePath: 'main.js', behavior: 'NETWORK_SEND', findingIds: ['a', 'b', 'c'], contexts, priority: 2 });
      const evidence: GroupExecutionEvidence[] = [{
        groupId: 'G1', filePath: 'main.js', behavior: 'NETWORK_SEND', runByLifecycle: ['postinstall'], runAsEntryPoint: [], position: 'CALLBACK',
        findings: [
          finding('a', 3, [step(9)]), finding('b', 4, [step(9)]),
          // An immediate call and a callback registration hold the Finding's body; they are not call sites to add.
          finding('c', 5, [{ kind: 'IMMEDIATE_CALL', line: 2, definition: { startLine: 2, endLine: 6 } }, { kind: 'CALLBACK_REGISTRATION', symbol: 'on', line: 4, statement: { startLine: 4, endLine: 6 } }]),
        ],
      }];
      const slice = (startLine: number, endLine: number) => ({ artifactId: ARTIFACT, filePath: 'main.js', startLine, endLine }) as AgentCodeSlice;
      const offered = (contexts: ContextCode[], slices: AgentCodeSlice[]) => executionPathCandidates([group(contexts)], evidence, slices)
        .map((candidate) => `${candidate.pathPurpose} ${candidate.startLine}-${candidate.endLine}`);
      // Findings a and b share the call on line 9; line 3 is in the slice, lines 4 and 5 are not.
      expect(offered(['TRIGGER', 'ACTION'], [slice(3, 3)])).toEqual(['CALL_SITE 9-9', 'FINDING_STATEMENT 4-4', 'FINDING_STATEMENT 5-5']);
      expect(offered(['TRIGGER'], [slice(1, 9)])).toEqual([]);
      expect(offered(['ACTION', 'LINK'], [slice(3, 3)])).toEqual([]);
    });

    it('takes path statements from the same line budget and never repeats them for another context', async () => {
      // LINK is MISSING too, and its candidates include the same `send();` statement; it is added once.
      const files = { 'install.js': ["const https = require('https');", 'function send() {', '  https.request(target).end();', '}', 'const target = pick();', 'send();'] };
      const run = await runEvidence(files, 3, undefined, undefined, { LINK: MISSING });
      const slices = run.outcome.built.input.initialCodeSlices.map((slice) => `${slice.startLine}-${slice.endLine}`);
      expect(slices.filter((range) => range === '6-6')).toHaveLength(1);
      expect(new Set(slices).size).toBe(slices.length);
      expect(run.outcome.record.addedLineCount).toBeLessThanOrEqual(expansionLineBudget(POLICY.codeSlices, 1));
      // No budget left for an expansion: no path statement is quoted or added.
      const tight = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxTotalCodeLines: POLICY.codeSlices.maxLinesPerSlice + 1 } };
      const none = await runEvidence(CALLED, 3, undefined, undefined, {}, tight);
      expect(none.trigger).not.toContain('are supplied in `slices`');
      expect(added(none)).toEqual([]);
      expect(none.outcome.record).toMatchObject({ status: 'SUFFICIENT', executionPathStatements: [] });
    });

    it('does not present a callback or an exported function as run, and adds no call site for them', async () => {
      const callback = await runEvidence(CALLBACK, 3);
      expect(callback.trigger).toContain('Finding line 3 [CALLBACK] reached from the file load through a callback handed to https.get at line 2 (its function is lines 2-4); '
        + 'the callback is only registered, and when it fires is not shown, so loading the file does not by itself run this code.');
      expect(callback.trigger).toContain('For this group the call chain from the file load to the flagged code is not confirmed for every Finding; that the file itself is loaded is not enough.');
      expect(callback.trigger).not.toContain('are supplied in `slices`');
      expect(added(callback)).toEqual([]);
      const exported = await runEvidence(EXPORTED, 2);
      expect(exported.trigger).toContain('Finding line 2 [EXPORTED_NOT_CALLED] inside a function that is only exported as send at line 1, which this file never calls, so loading the file does not run this code.');
      expect(exported.outcome.record.executionEvidence[0]).toMatchObject({ position: 'EXPORTED_NOT_CALLED', runByLifecycle: ['postinstall'] });
      expect(added(exported)).toEqual([]);
    });

    it('says what Scanner cannot establish, and that a callback starting on the Finding line is only registered', async () => {
      const unknown = await runEvidence({ 'install.js': ['const table = { go() {', '  https.request(url).end();', '} };', 'table[name]();'] }, 2);
      expect(unknown.trigger).toContain('Finding line 2 [UNKNOWN] in code for which Scanner found no call from the file load, so loading the file is not shown to run this code.');
      expect(unknown.trigger).toContain('is not confirmed for every Finding');
      const noLoader = projectExecution(await project(CALLED), 'install.js', 3, {});
      const slices = (await build(noLoader)).input.initialCodeSlices;
      const groups = buildFindingGroups(noLoader, slices);
      const evidence = [{ ...unknown.outcome.record.executionEvidence[0]!, runByLifecycle: [], runAsEntryPoint: [] }];
      expect(buildContextCheckRequest(noLoader, slices, groups, { groups: evidence, mode: 'INSTRUCTION' }).questions.G1__TRIGGER!.instructions)
        .toContain('`install.js` is not run directly by a lifecycle script and is not an entry point.');
      // A callback that starts on the Finding line: the statement runs at load, the callback body does not count as run.
      const onLine = await runEvidence({ 'install.js': ['exec(command, (error) => {', '  log(error);', '});'] }, 1);
      expect(onLine.outcome.record.executionEvidence[0]).toMatchObject({ position: 'TOP_LEVEL', findings: [{ callbackStartsOnLine: true }] });
      expect(onLine.trigger).toContain('Finding line 1 [TOP_LEVEL] outside every function, so this statement runs when the file is loaded; '
        + 'a callback also starts on this line, and code inside that callback is only registered.');
    });

    it('quotes a call site that several groups need in the TRIGGER question of each of them and adds it once', async () => {
      const files = { 'install.js': ['function work() {', '  https.request(url).end();', '  const data = os.hostname();', '}', '', 'work();'] };
      const input = projectExecution(await project(files), 'install.js', 2, POSTINSTALL);
      const second = 'tier1:sysinfo:2';
      input.findings.push({ ...input.findings[0]!, findingId: second, ruleId: 'threat-runtime-system-info', kind: 'THREAT', location: { file: 'install.js', startLine: 3, endLine: 3 } });
      input.bindings.findingBindings.push({ ...input.bindings.findingBindings[0]!, findingId: second, startLine: 3, endLine: 3 });
      input.validatedPlan.targets[0] = { ...input.validatedPlan.targets[0]!, preferredRange: { startLine: 2, endLine: 3 }, findingRefs: [FINDING, second] };
      const built = await build(input);
      const jev = provider();
      const outcome = await runContextCheck({ enabled: true, provider: jev, execution: input, built, policy: POLICY.codeSlices, rebuild: (expanded, supplement) => build(expanded, supplement) });
      const request = jev.check.mock.calls[0]![0];
      const triggers = Object.entries(request.questions).filter(([key]) => key.endsWith('__TRIGGER')).map(([, question]) => question.instructions);
      expect(triggers).toHaveLength(2);
      for (const instructions of triggers) expect(instructions).toContain('slice `EXECUTION-PATH-1`, lines 6-6 (call site).');
      // One slice in the request, however many groups point at it.
      expect((request.state as { slices: Array<{ sliceId: string }> }).slices.filter((slice) => slice.sliceId.startsWith('EXECUTION-PATH-'))).toHaveLength(1);
      expect(outcome.built.input.initialCodeSlices.map((slice) => `${slice.startLine}-${slice.endLine}`)).toEqual(['2-3', '6-6']);
      expect(outcome.record.executionPathStatements).toHaveLength(1);
    });

    it('tells Tier 3 where the Finding sits when TRIGGER stays unresolved, and nothing when that is unknown', async () => {
      const triggerNote = async (files: Record<string, string[]>, line: number) => {
        const run = await runEvidence(files, line, undefined, undefined, { TRIGGER: { score: 1, confidence: 1 } });
        return run.outcome.built.input.missingData.filter((item) => item.reason.includes('TRIGGER context')).map((item) => item.reason);
      };
      expect(await triggerNote(CALLBACK, 3)).toEqual([
        'install.js (NETWORK_SEND): TRIGGER context is PARTIAL in the supplied slices; the postinstall script runs this file directly; '
        + 'the flagged code is in a callback that is registered when the file is loaded, and when that callback fires is not established; no other caller or entry point was found.',
      ]);
      expect(await triggerNote({ 'install.js': ['const = ;', 'https.request(url).end();'] }, 2)).toEqual([
        'install.js (NETWORK_SEND): TRIGGER context is PARTIAL in the supplied slices; the postinstall script runs this file directly; no other caller or entry point was found.',
      ]);
    });

    it('keeps a Finding without a line or in an unreadable file unknown', async () => {
      const noLine = await runEvidence(CALLED, 3, undefined, (input) => {
        input.bindings.findingBindings = input.bindings.findingBindings.map(({ startLine: _start, endLine: _end, ...binding }) => binding as typeof input.bindings.findingBindings[number]);
      });
      expect(noLine.outcome.record.executionEvidence[0]).toMatchObject({ position: 'UNKNOWN', findings: [{ startLine: null, statement: null, position: 'UNKNOWN' }] });
      expect(added(noLine)).toEqual([]);
      const broken = await runEvidence({ 'install.js': ['const = ;', 'https.request(url).end();'] }, 2);
      expect(broken.outcome.record.executionEvidence[0]).toMatchObject({ position: 'UNKNOWN' });
    });

    it('reads a Finding that has a start line only as that one line', async () => {
      const startOnly = (input: Tier3ExecutionInput) => {
        input.bindings.findingBindings = input.bindings.findingBindings.map(({ endLine: _end, ...binding }) => binding as typeof input.bindings.findingBindings[number]);
      };
      const called = await runEvidence(CALLED, 3, undefined, startOnly);
      expect(called.outcome.record.executionEvidence[0]).toMatchObject({ position: 'CALLED_AT_LOAD', findings: [{ startLine: 3 }] });
      // With the product default, a top-level Finding with a start line only lets the TRIGGER question be left out.
      const input = projectExecution(await project({ 'install.js': ["const https = require('https');", 'https.request(url).end();'] }), 'install.js', 2, POSTINSTALL);
      startOnly(input);
      const built = await build(input);
      const outcome = await runContextCheckWithDefaults({ enabled: true, provider: provider(), execution: input, built, policy: POLICY.codeSlices, rebuild: (expanded, supplement) => build(expanded, supplement) });
      expect(outcome.record.omittedQuestions).toMatchObject([{ groupId: 'G1', reason: 'LIFECYCLE_RUNS_FILE_AT_LOAD' }]);
      expect(outcome.record.executionEvidence[0]).toMatchObject({ position: 'TOP_LEVEL' });
    });

    it('records the evidence in every mode and never holds code in it', async () => {
      const none = await runEvidence(CALLED, 3, 'NONE');
      const final = await runEvidence(CALLED, 3);
      expect(none.outcome.record.executionEvidence).toEqual(final.outcome.record.executionEvidence);
      expect(added(none)).toEqual([]);
      expect(JSON.stringify(final.outcome.record.executionEvidence)).not.toContain('https.request');
      expect(JSON.stringify(final.outcome.record.executionPathStatements)).not.toContain('send()');
    });
  });

  describe('lifecycle TRIGGER omission', () => {
    const POSTINSTALL = { scripts: { postinstall: 'node install.js' } };
    const AT_LOAD = { 'install.js': ["const https = require('https');", 'const request = https.request(url);', 'request.end();'] };
    const IN_FUNCTION = { 'install.js': ["const https = require('https');", 'function send() {', '  https.request(url).end();', '}', 'send();'] };
    const OTHER_CONTEXTS = ['G1__INPUT', 'G1__ACTION', 'G1__TARGET', 'G1__LINK'];

    /** Runs with the product default unless `mode` is given; every answer is MISSING unless `answers` says otherwise. */
    async function runMode(files: Record<string, string[]>, line: number, options: Parameters<typeof projectExecution>[3], mode?: LifecycleTriggerQuestion) {
      const input = projectExecution(await project(files), 'install.js', line, options);
      const built = await build(input);
      const jev = provider();
      const outcome = await runContextCheckWithDefaults({
        enabled: true, provider: jev, execution: input, built, policy: POLICY.codeSlices, rebuild: (expanded, supplement) => build(expanded, supplement),
        ...(mode === undefined ? {} : { lifecycleTriggerQuestion: mode }),
      });
      const request = jev.check.mock.calls[0]![0];
      return { outcome, built, asked: Object.keys(request.questions), request };
    }

    it('tells code that runs at load from code inside a function, a callback or a class', () => {
      const code = ['run(1);', 'function later() {', '  run(2);', '}', 'get(url, (res) => {', '  run(3);', '});', 'class A { m() { run(4); } }', 'if (ok) run(5);'].join('\n');
      expect(runsAtLoad(code, { startLine: 1, endLine: 1 })).toBe(true);
      expect(runsAtLoad(code, { startLine: 9, endLine: 9 })).toBe(true);
      expect(runsAtLoad(code, { startLine: 3, endLine: 3 })).toBe(false);
      // A call whose callback starts on the same line is not counted as running at load.
      expect(runsAtLoad(code, { startLine: 5, endLine: 5 })).toBe(false);
      expect(runsAtLoad(code, { startLine: 6, endLine: 6 })).toBe(false);
      expect(runsAtLoad(code, { startLine: 8, endLine: 8 })).toBe(false);
      // Nothing can be said about a file that does not parse or about lines without code.
      expect(runsAtLoad('const = ;\nrun(1);', { startLine: 2, endLine: 2 })).toBe(false);
      expect(runsAtLoad(code, { startLine: 40, endLine: 40 })).toBe(false);
    });

    it('does not ask TRIGGER when a lifecycle script runs the file and the Finding runs at load', async () => {
      const { outcome, built, asked, request } = await runMode(AT_LOAD, 2, POSTINSTALL);
      expect(asked).toEqual(OTHER_CONTEXTS);
      expect(outcome.record.omittedQuestions).toEqual([
        { groupId: 'G1', filePath: 'install.js', behavior: 'NETWORK_SEND', context: 'TRIGGER', reason: 'LIFECYCLE_RUNS_FILE_AT_LOAD', scripts: ['postinstall'] },
      ]);
      // The context has no state at all: it is neither VISIBLE nor reported as missing.
      expect(outcome.record.states.map((state) => state.context)).toEqual(['INPUT', 'ACTION', 'TARGET', 'LINK']);
      expect(outcome.built.input.missingData.some((item) => item.reason.includes('TRIGGER context'))).toBe(false);
      // The lifecycle fact still reaches the model and the Agent input.
      expect((request.state as { groups: unknown[] }).groups[0]).toMatchObject({ runByLifecycle: ['postinstall'] });
      expect(outcome.built.input.packageContext.lifecycleScripts).toEqual(built.input.packageContext.lifecycleScripts);
      expect(outcome.built.input.packageContext.lifecycleScripts).toMatchObject([{ name: 'postinstall', command: 'node install.js' }]);
    });

    it('still asks TRIGGER when the Finding is inside a function, and leaves it out only in the measurement mode', async () => {
      const strict = await runMode(IN_FUNCTION, 3, POSTINSTALL);
      expect(strict.asked).toEqual(['G1__TRIGGER', ...OTHER_CONTEXTS]);
      expect(strict.outcome.record.omittedQuestions).toEqual([]);
      const always = await runMode(IN_FUNCTION, 3, POSTINSTALL, 'OMIT_WHEN_RUN_BY_LIFECYCLE');
      expect(always.asked).toEqual(OTHER_CONTEXTS);
      expect(always.outcome.record.omittedQuestions).toMatchObject([{ groupId: 'G1', reason: 'LIFECYCLE_RUNS_FILE', scripts: ['postinstall'] }]);
    });

    it('asks TRIGGER when no lifecycle script runs the file itself', async () => {
      // A lifecycle script exists but runs another file.
      const other = await runMode({ ...AT_LOAD, 'setup.js': ['console.log(1);'] }, 2, { scripts: { postinstall: 'node setup.js' } });
      expect(other.asked).toContain('G1__TRIGGER');
      // The file is only the main entry point.
      const main = await runMode(AT_LOAD, 2, { main: 'install.js' });
      expect(main.asked).toContain('G1__TRIGGER');
      const none = await runMode(AT_LOAD, 2, {});
      expect(none.asked).toContain('G1__TRIGGER');
      for (const run of [other, main, none]) expect(run.outcome.record.omittedQuestions).toEqual([]);
    });

    it('asks TRIGGER when the file cannot be read as statements', async () => {
      const broken = await runMode({ 'install.js': ['const = ;', 'https.request(url).end();'] }, 2, POSTINSTALL);
      expect(broken.asked).toContain('G1__TRIGGER');
      expect(broken.outcome.record.omittedQuestions).toEqual([]);
    });

    it('asks every question in the ASK mode', async () => {
      const ask = await runMode(AT_LOAD, 2, POSTINSTALL, 'ASK');
      expect(ask.asked).toEqual(['G1__TRIGGER', ...OTHER_CONTEXTS]);
      expect(ask.outcome.record.omittedQuestions).toEqual([]);
    });
  });

  describe('INPUT through a called function', () => {
    const inputNotes = (outcome: Awaited<ReturnType<typeof runOn>>['outcome']) => outcome.built.input.missingData
      .filter((item) => item.field === 'contextCheck' && item.reason.includes('INPUT context')).map((item) => item.reason);

    it('follows payload = collect() to the local definition of collect and resolves INPUT', async () => {
      const files = { 'main.js': ['function collect() { return process.env.HOME; }', 'let payload = null;', 'payload = collect();', 'send(payload);'] };
      const { outcome, trace } = await runOn(files, 'main.js', 4, { INPUT: MISSING });
      expect(describeTrace(trace)).toEqual([
        '1 SAME_FILE_DEFINITION main.js:3-3 -> 3-3', '1 SAME_FILE_DEFINITION main.js:2-2 -> 2-2', '2 LOCAL_FUNCTION main.js:1-1 -> 1-1',
      ]);
      expect(inputNotes(outcome)).toEqual([]);
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 0 });
    });

    it('follows payload = collect() to an imported definition and resolves INPUT', async () => {
      const files = {
        'main.js': ["const collect = require('./collect');", 'const payload = collect();', 'send(payload);'],
        'collect.js': ['function collect() {', '  return { home: process.env.HOME };', '}', 'module.exports = collect;'],
      };
      const { outcome, trace } = await runOn(files, 'main.js', 3, { INPUT: MISSING });
      expect(describeTrace(trace)).toContain('2 STATIC_IMPORT collect.js:1-4 -> 1-4');
      expect(inputNotes(outcome)).toEqual([]);
    });

    it('keeps INPUT missing when the called function relies on another function', async () => {
      const files = { 'main.js': ['function helper() { return 1; }', 'function collect() { return helper(); }', 'const payload = collect();', 'send(payload);'] };
      const { outcome, trace } = await runOn(files, 'main.js', 4, { INPUT: MISSING });
      // collect's definition is added, but it hides its value behind helper, which is not followed.
      expect(describeTrace(trace)).toEqual(['1 SAME_FILE_DEFINITION main.js:3-3 -> 3-3', '2 LOCAL_FUNCTION main.js:2-2 -> 2-2']);
      expect(inputNotes(outcome)).toEqual(['main.js (NETWORK_SEND): INPUT context was MISSING at the first check; code was added afterwards and not rated again, so whether it settles this is not established.']);
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 1 });
    });

    it('keeps INPUT missing when the called export cannot be found or the call goes through a module object', async () => {
      const missingExport = await runOn({
        'main.js': ["const { collect } = require('./lib');", 'const payload = collect();', 'send(payload);'],
        'lib.js': ['module.exports = { other: () => 0 };'],
      }, 'main.js', 3, { INPUT: MISSING });
      expect(missingExport.trace.some((entry) => entry.depth === 2)).toBe(false);
      expect(inputNotes(missingExport.outcome)).toHaveLength(1);

      const throughObject = await runOn({
        'main.js': ["const tools = require('./tools');", 'const payload = tools.collect();', 'send(payload);'],
        'tools.js': ['exports.collect = () => 1;'],
      }, 'main.js', 3, { INPUT: MISSING });
      expect(inputNotes(throughObject.outcome)).toHaveLength(1);
    });

    it('takes PARTIAL INPUT to the first hop only, so a value from a call stays unresolved', async () => {
      const files = { 'main.js': ['function collect() { return process.env.HOME; }', 'const payload = collect();', 'send(payload);'] };
      const partial = await runOn(files, 'main.js', 3, { INPUT: { score: 1, confidence: 1 } });
      expect(describeTrace(partial.trace)).toEqual(['1 SAME_FILE_DEFINITION main.js:2-2 -> 2-2']);
      expect(partial.outcome.built.input.missingData.filter((item) => item.reason.includes('INPUT context')).map((item) => item.reason)).toEqual([
        'main.js (NETWORK_SEND): INPUT context was PARTIAL at the first check; code was added afterwards and not rated again, so whether it settles this is not established.',
      ]);
    });

    it('resolves INPUT from direct sources without a second hop', async () => {
      const files = { 'main.js': ["const os = require('os');", 'const host = os.hostname();', 'send(host);'] };
      const { outcome, trace } = await runOn(files, 'main.js', 3, { INPUT: MISSING });
      expect(trace.every((entry) => entry.depth === 1)).toBe(true);
      expect(inputNotes(outcome)).toEqual([]);
    });
  });

  /**
   * main.js line 7 uses `first` and `second` (first hop); they use `make` and `seed` (second hop);
   * `make` uses `inner` and `seed` uses `helper` (third hop, never reached).
   */
  const LINK_PROJECT = {
    'main.js': [
      "const helper = require('./helper');",
      'function inner(value) { return value + 1; }',
      'function make(value) { return inner(value); }',
      'const seed = helper.seed;',
      'const first = make(seed);',
      'const second = make(seed);',
      'send(first, second);',
    ],
    'helper.js': ['module.exports = { seed: 1 };'],
  };
  /** main.js line 2 calls `run` from runner.js; runner.js requires deep.js and main.js back; deep.js requires deeper.js. */
  const ACTION_PROJECT = {
    'main.js': ["const run = require('./runner');", 'run(1);'],
    'runner.js': ["const back = require('./main');", "const deep = require('./deep');", 'module.exports = (value) => deep(back, value);'],
    'deep.js': ["const deeper = require('./deeper');", 'module.exports = (a, b) => deeper(a, b);'],
    'deeper.js': ['module.exports = () => 0;'],
  };

  describe('exploration by score with a VISIBLE confidence floor', () => {
    const LOW = { score: 0, confidence: 0.59 };
    const VERY_LOW = { score: 0, confidence: 0.49 };

    it('keeps MISSING score-only and holds a low-confidence VISIBLE score as PARTIAL', () => {
      expect(contextState(LOW)).toBe('MISSING');
      expect(explorationClass('LINK', LOW)).toBe('MISSING');
      expect(explorationClass('ACTION', VERY_LOW)).toBe('MISSING');
      expect(explorationClass('LINK', { score: 1, confidence: 0.1 })).toBe('PARTIAL');
      expect(explorationClass('LINK', { score: 2, confidence: 0.1 })).toBe('PARTIAL');
      expect(explorationClass('LINK', MISSING)).toBe('MISSING');
    });

    it('takes a MISSING-score LINK to the second hop at any confidence', async () => {
      for (const answer of [LOW, VERY_LOW, MISSING]) {
        const { trace } = await runOn(LINK_PROJECT, 'main.js', 7, { LINK: answer });
        expect(describeTrace(trace)).toEqual([
          '1 SAME_FILE_DEFINITION main.js:6-6 -> 6-6', '1 SAME_FILE_DEFINITION main.js:5-5 -> 5-5',
          '2 SAME_FILE_DEFINITION main.js:4-4 -> 4-4', '2 LOCAL_FUNCTION main.js:3-3 -> 3-3',
        ]);
      }
    });

    it('keeps a PARTIAL-score LINK at the first hop', async () => {
      const { trace } = await runOn(LINK_PROJECT, 'main.js', 7, { LINK: { score: 1, confidence: 0.2 } });
      expect(trace.every((entry) => entry.depth === 1)).toBe(true);
    });
  });

  describe('second hop', () => {
    it('follows the variables and local functions a MISSING LINK\'s first-hop statements use, once each, and stops there', async () => {
      expect(describeCandidates(await candidatesFor(LINK_PROJECT, 'main.js', 7, [['LINK', 'MISSING']]))).toEqual([
        'LINK MISSING 1 SAME_FILE_DEFINITION main.js:6-6 second',
        'LINK MISSING 1 SAME_FILE_DEFINITION main.js:5-5 first',
        // Lines 5 and 6 both use `seed` and `make`; each is offered once. `inner` and `helper` would be a third hop.
        'LINK MISSING 2 SAME_FILE_DEFINITION main.js:4-4 seed',
        'LINK MISSING 2 LOCAL_FUNCTION main.js:3-3 make',
      ]);
    });

    it('follows the static import a MISSING ACTION\'s first-hop export uses, without re-entering the group\'s file', async () => {
      expect(describeCandidates(await candidatesFor(ACTION_PROJECT, 'main.js', 2, [['ACTION', 'MISSING']]))).toEqual([
        'ACTION MISSING 1 STATIC_IMPORT runner.js:3-3 default',
        // runner.js uses deep.js and main.js; main.js is the group's own file. deeper.js would be a third hop.
        'ACTION MISSING 2 STATIC_IMPORT deep.js:2-2 default',
      ]);
    });

    it('keeps PARTIAL LINK and ACTION at the first hop', async () => {
      expect(describeCandidates(await candidatesFor(LINK_PROJECT, 'main.js', 7, [['LINK', 'PARTIAL']]))).toEqual([
        'LINK PARTIAL 1 SAME_FILE_DEFINITION main.js:6-6 second', 'LINK PARTIAL 1 SAME_FILE_DEFINITION main.js:5-5 first',
      ]);
      expect(describeCandidates(await candidatesFor(ACTION_PROJECT, 'main.js', 2, [['ACTION', 'PARTIAL']]))).toEqual([
        'ACTION PARTIAL 1 STATIC_IMPORT runner.js:3-3 default',
      ]);
    });

    it('keeps MISSING TRIGGER and TARGET at the first hop and takes MISSING INPUT only to the called function', async () => {
      const candidates = await candidatesFor(LINK_PROJECT, 'main.js', 7, [['TRIGGER', 'MISSING'], ['INPUT', 'MISSING'], ['TARGET', 'MISSING']]);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.filter((candidate) => candidate.context !== 'INPUT').every((candidate) => candidate.depth === 1)).toBe(true);
      // `first = make(seed)` and `second = make(seed)` call make; its definition is the only second-hop INPUT candidate.
      expect(describeCandidates(candidates.filter((candidate) => candidate.context === 'INPUT' && candidate.depth === 2))).toEqual(['INPUT MISSING 2 LOCAL_FUNCTION main.js:3-3 make']);
    });

    it('never repeats a candidate for the same context, range and symbol', async () => {
      const candidates = await candidatesFor(ACTION_PROJECT, 'main.js', 2, [['ACTION', 'MISSING'], ['LINK', 'MISSING']]);
      const keys = candidates.map((candidate) => `${candidate.context} ${candidate.filePath}:${candidate.startLine}-${candidate.endLine} ${candidate.symbol ?? ''}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(candidates.some((candidate) => candidate.filePath === 'main.js' && candidate.kind === 'STATIC_IMPORT')).toBe(false);
      expect(candidates.some((candidate) => candidate.filePath === 'deeper.js')).toBe(false);
    });

    it('selects first-hop candidates before second-hop ones when lines run out', async () => {
      // One line is in the slices and two are kept for Tier 3, which leaves an expansion budget of 2 lines.
      const tight = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxLinesPerSlice: 2, maxTotalCodeLines: 5 } };
      const { trace } = await runOn(LINK_PROJECT, 'main.js', 7, { LINK: MISSING }, tight);
      expect(describeTrace(trace)).toEqual([
        '1 SAME_FILE_DEFINITION main.js:6-6 -> 6-6', '1 SAME_FILE_DEFINITION main.js:5-5 -> 5-5',
        '2 SAME_FILE_DEFINITION main.js:4-4 LINE_BUDGET_EXCEEDED', '2 LOCAL_FUNCTION main.js:3-3 LINE_BUDGET_EXCEEDED',
      ]);
    });

    it('keeps first and second hop within the expansion budget and leaves one re-request for Tier 3', async () => {
      const body = (name: string, call = '') => [`function ${name}() {`, ...Array.from({ length: 48 }, (_, index) => `  step${index}(${index === 0 ? call : ''});`), '}'];
      const files = { 'main.js': [...body('a', 'd()'), ...body('b'), ...body('c'), ...body('d'), 'send(a(), b(), c());'] };
      const { built, outcome, trace } = await runOn(files, 'main.js', 201, { LINK: MISSING });
      const lines = (slices: readonly { startLine: number; endLine: number }[]) => slices.reduce((sum, slice) => sum + slice.endLine - slice.startLine + 1, 0);
      const selected = trace.filter((entry) => entry.selected);
      expect(selected.reduce((sum, entry) => sum + entry.lineCount, 0)).toBeLessThanOrEqual(CONTEXT_CHECK_LIMITS.maxExpansionLines);
      expect(selected.map((entry) => `${entry.depth} ${entry.symbol}`).sort()).toEqual(['1 a', '1 b', '1 c', '2 d']);
      expect(trace.filter((entry) => !entry.selected)).toEqual([]);
      expect(outcome.record.addedLineCount).toBe(200);
      expect(POLICY.codeSlices.maxTotalCodeLines - lines(outcome.built.input.initialCodeSlices)).toBeGreaterThanOrEqual(POLICY.codeSlices.maxLinesPerSlice);
      expect(outcome.built.input.analysisPolicy).toEqual(built.input.analysisPolicy);
    });
  });
});

describe('context check candidate trace', () => {
  const TRACE_PATH = join(__dirname, '..', CANDIDATE_TRACE_RELATIVE_PATH);
  const traceFileState = () => (existsSync(TRACE_PATH) ? statSync(TRACE_PATH).mtimeMs : 'absent');

  async function traced(onCandidateTrace?: (entries: readonly CandidateTraceEntry[]) => void) {
    const input = execution();
    const built = await build(input);
    return runContextCheck({ enabled: true, provider: provider({}, MISSING), execution: input, built, rebuild: build, policy: POLICY.codeSlices, ...(onCandidateTrace ? { onCandidateTrace } : {}) });
  }

  it('reports every candidate with its offered and selected ranges and no code', async () => {
    const entries: CandidateTraceEntry[] = [];
    await traced((items) => entries.push(...items));
    expect(entries.length).toBeGreaterThan(0);
    const allowed = ['artifactId', 'candidateEndLine', 'candidateStartLine', 'context', 'depth', 'exclusionReason', 'filePath', 'groupId', 'kind', 'lineCount', 'selected', 'selectedEndLine', 'selectedStartLine', 'symbol', 'lowConfidenceMissing', 'score', 'confidence'];
    for (const entry of entries) {
      for (const key of Object.keys(entry)) expect(allowed).toContain(key);
      expect(entry.selected).toBe(entry.exclusionReason === null);
      expect(entry.selected).toBe(entry.selectedStartLine !== null);
      if (entry.selected) expect(entry.lineCount).toBe(entry.selectedEndLine! - entry.selectedStartLine! + 1);
    }
    expect(entries.some((entry) => entry.symbol !== undefined)).toBe(true);
  });

  it('leaves the Agent input and the record unchanged, even when the callback throws', async () => {
    const plain = await traced();
    const tracedOutcome = await traced(() => { throw new Error('trace sink failed'); });
    expect(tracedOutcome.built.input).toEqual(plain.built.input);
    expect(tracedOutcome.record).toEqual(plain.record);
    expect(plain.record).not.toHaveProperty('trace');
    expect(JSON.stringify(plain.built.input)).not.toContain('exclusionReason');
  });

  it('formats one JSON object per line with the run and only the listed fields', () => {
    const entries: CandidateTraceEntry[] = [
      {
        groupId: 'G1', context: 'LINK', depth: 2, kind: 'LOCAL_FUNCTION', artifactId: DEOBFUSCATED, filePath: 'install.js',
        candidateStartLine: 1, candidateEndLine: 10, selectedStartLine: 8, selectedEndLine: 10, lineCount: 3, symbol: 'encode', selected: true, exclusionReason: null,
        lowConfidenceMissing: true, score: 0.28, confidence: 0.58,
      },
      // Extra properties, such as code, never reach the line.
      {
        ...{ content: 'request.write(encode(payload));', apiKey: 'test-key' }, groupId: 'G1', context: 'ACTION', depth: 1, kind: 'STATIC_IMPORT',
        artifactId: ORIGINAL, filePath: 'lib/collect.js', candidateStartLine: 1, candidateEndLine: 2, selectedStartLine: null, selectedEndLine: null,
        lineCount: 2, selected: false, exclusionReason: 'NO_MEANINGFUL_CODE', lowConfidenceMissing: false, score: null, confidence: null,
      } as CandidateTraceEntry,
    ];
    const text = formatCandidateTrace(entries, { runId: 'context-check-smoke-1', recordedAt: '2026-10-03T00:00:00.000Z' });
    const lines = text.split('\n');
    expect(lines.at(-1)).toBe('');
    const records = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual([
      {
        runId: 'context-check-smoke-1', recordedAt: '2026-10-03T00:00:00.000Z', groupId: 'G1', context: 'LINK', depth: 2, kind: 'LOCAL_FUNCTION',
        artifactId: DEOBFUSCATED, filePath: 'install.js', candidateStartLine: 1, candidateEndLine: 10, selectedStartLine: 8, selectedEndLine: 10,
        lineCount: 3, symbol: 'encode', selected: true, exclusionReason: null, lowConfidenceMissing: true, score: 0.28, confidence: 0.58,
      },
      {
        runId: 'context-check-smoke-1', recordedAt: '2026-10-03T00:00:00.000Z', groupId: 'G1', context: 'ACTION', depth: 1, kind: 'STATIC_IMPORT',
        artifactId: ORIGINAL, filePath: 'lib/collect.js', candidateStartLine: 1, candidateEndLine: 2, selectedStartLine: null, selectedEndLine: null,
        lineCount: 2, selected: false, exclusionReason: 'NO_MEANINGFUL_CODE', lowConfidenceMissing: false, score: null, confidence: null,
      },
    ]);
    expect(text).not.toContain('request.write');
    expect(text).not.toContain('test-key');
    expect(text).not.toContain('apiKey');
  });

  it('writes no trace file when the check runs, with or without a callback', async () => {
    expect(CANDIDATE_TRACE_RELATIVE_PATH).toBe('reports/validation/context-check-candidate-trace.ndjson');
    const before = traceFileState();
    await traced((entries) => entries);
    await traced();
    expect(traceFileState()).toBe(before);
  });
});

describe('context check with the program index', () => {
  const ARTIFACT = 'ARTIFACT-INDEX';
  const roots: string[] = [];
  afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
  type Files = Record<string, string[]>;

  async function project(files: Files): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'context-check-index-'));
    roots.push(root);
    for (const [path, lines] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `${lines.join('\n')}\n`);
    }
    return root;
  }
  const lineOf = (files: Files, file: string, marker: string): number => files[file]!.findIndex((text) => text.includes(marker)) + 1;

  /** One Finding on the line of `file` that holds `marker`, sliced alone; `command` is the postinstall script. */
  async function executionFor(files: Files, file: string, command = 'node index.js', marker = 'FINDING'): Promise<Tier3ExecutionInput> {
    const root = await project(files);
    const line = lineOf(files, file, marker);
    return {
      validatedPlan: {
        planId: 'PLAN-INDEX', shouldExecute: true, analysisMode: 'ORIGINAL_ONLY',
        targets: [{ targetId: 'tier3-target-001', artifactId: ARTIFACT, filePath: file, preferredRange: { startLine: line, endLine: line }, priority: 'HIGH', findingRefs: [FINDING], evidenceRefs: [], reasonCodes: ['TIER1_FINDING'] }],
        focusBehaviors: ['NETWORK_EGRESS'], analysisTargets: [], limitations: [], validation: { status: 'VALIDATED' },
      },
      artifacts: new StaticArtifactResolver([{ root, descriptor: { artifactId: ARTIFACT, representation: 'ORIGINAL', analysisPass: 'TIER1', contentSha256: HASH, lineageStatus: 'DIRECT', producer: 'safe-extract' } }]),
      findings: [{ findingId: FINDING, analyzer: 'custom-rule', analyzerVersion: '1', ruleId: 'custom.network-outbound', kind: 'CAPABILITY', description: 'Finding', location: { file, startLine: line, endLine: line }, rawMatch: null }],
      atomicEvidences: [],
      bindings: { findingBindings: [{ findingId: FINDING, artifactId: ARTIFACT, filePath: file, startLine: line, endLine: line }], evidenceBindings: [] },
      packageContext: {
        source: 'TARBALL_PACKAGE_MANIFEST_PROJECTION', description: null, main: null, exports: null, scripts: { postinstall: command }, dependencies: {},
        entryPoints: [], lifecycleScripts: [{ name: 'postinstall', command, location: null }],
      },
    };
  }

  async function runWith(input: Tier3ExecutionInput, answers: Partial<Record<string, ScoreAnswer>> = {}, options: Partial<ContextCheckInput> = {}, policy = POLICY) {
    const built = await build(input, undefined, policy);
    const jev = provider(answers);
    const trace: CandidateTraceEntry[] = [];
    const outcome = await runContextCheckWithDefaults({
      enabled: true, provider: jev, execution: input, built, policy: policy.codeSlices, lifecycleTriggerQuestion: 'ASK',
      rebuild: (expanded, supplement) => build(expanded, supplement, policy), onCandidateTrace: (entries) => trace.push(...entries), ...options,
    });
    const request = jev.check.mock.calls[0]?.[0];
    const question = (context: ContextCode) => request?.questions[`G1__${context}`]?.instructions ?? '';
    const sliceText = (slices: readonly AgentCodeSlice[]) => slices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`);
    return { built, outcome, request, question, trace, added: sliceText(outcome.built.input.initialCodeSlices.slice(built.input.initialCodeSlices.length)) };
  }
  const missing = (outcome: { built: { input: AgentAnalysisInputV0_3 } }, context: ContextCode) => outcome.built.input.missingData
    .filter((item) => item.field === 'contextCheck' && item.reason.includes(`${context} context`)).map((item) => item.reason);
  const traced = (trace: readonly CandidateTraceEntry[], context: ContextCode) => trace.filter((entry) => entry.context === context)
    .map((entry) => `${entry.kind} ${entry.filePath}:${entry.candidateStartLine}-${entry.candidateEndLine} ${entry.selected ? 'selected' : entry.exclusionReason}`);

  const CHAIN: Files = {
    'index.js': ["const { boot } = require('./src/boot');", 'boot();'],
    'src/boot.js': ["const { send } = require('./send');", 'exports.boot = function boot() {', '  send(process.env.TOKEN);', '};'],
    'src/send.js': ["const https = require('https');", 'exports.send = function send(payload) {', '  https.request(endpoint).end(payload); // FINDING', '};'],
  };

  it('uses confidence only for PROBABLE witnesses and takes direct evidence without a complete path', async () => {
    const confirmedFiles: Files = { 'index.js': ["const https = require('https');", 'https.request(endpoint).end(payload); // FINDING'] };
    const confirmed = await runWith(await executionFor(confirmedFiles, 'index.js'), { ACTION: { score: 1.2, confidence: 0 } });
    expect(confirmed.outcome.record.states.find((state) => state.context === 'ACTION')).toMatchObject({ state: 'VISIBLE', score: 1.2, confidence: 0 });

    const probableFiles: Files = { 'index.js': ['function send() {', '  https.request(endpoint).end(); // FINDING', '}', 'let run = send;', 'run = run;', 'run();'] };
    // A TRIGGER path with a probable step needs the stronger answer.
    const stateOf = async (answer: ScoreAnswer) => (await runWith(await executionFor(probableFiles, 'index.js'), { TRIGGER: answer })).outcome.record.states.find((state) => state.context === 'TRIGGER')!.state;
    expect(await stateOf({ score: 1.4, confidence: 1 })).toBe('PARTIAL');
    expect(await stateOf({ score: 1.5, confidence: 0.39 })).toBe('PARTIAL');
    expect(await stateOf({ score: 1.5, confidence: 0.4 })).toBe('VISIBLE');

    const unresolvedFiles: Files = { 'index.js': ["const agent = require('private-agent');", 'function send(data) {', '  agent.post(url, data);', '}', 'send(payload); // FINDING'] };
    const unresolved = await runWith(await executionFor(unresolvedFiles, 'index.js'), { ACTION: { score: 2, confidence: 1 } });
    // No complete ACTION path, but the Finding's whole statement is in the slices: the answer stands, whatever its confidence.
    expect(unresolved.outcome.record.states.find((state) => state.context === 'ACTION')).toMatchObject({ state: 'VISIBLE', score: 2, confidence: 1 });
    expect(unresolved.outcome.record.witnessPaths!.find((path) => path.context === 'ACTION')).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY' });
    expect(missing(unresolved.outcome, 'ACTION')).toEqual([]);
    const unsure = await runWith(await executionFor(unresolvedFiles, 'index.js'), { ACTION: { score: 1.2, confidence: 0 } });
    expect(unsure.outcome.record.states.find((state) => state.context === 'ACTION')).toMatchObject({ state: 'VISIBLE' });
  });

  it('ties a Finding to the lifecycle script across files, tells the model so and supplies the path as slices', async () => {
    const input = await executionFor(CHAIN, 'src/send.js');
    const run = await runWith(input);
    const [finding] = run.outcome.record.executionEvidence[0]!.findings;
    // The single-file reading is unchanged: the function is exported and this file does not call it.
    expect(finding!.position).toBe('EXPORTED_NOT_CALLED');
    expect(finding!.reach).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', asyncBoundary: false, root: { kind: 'LIFECYCLE', name: 'postinstall', filePath: 'index.js' } });
    expect(finding!.reach!.steps.map((step) => `${step.kind} ${step.calleeSymbol} ${step.filePath}:${step.startLine}`)).toEqual(['CALL boot index.js:2', 'CALL send src/boot.js:3']);
    const trigger = run.question('TRIGGER');
    expect(trigger).toContain('`src/send.js` is not run directly by a lifecycle script and is not an entry point.');
    expect(trigger).toContain('Finding line 3 [CALLED_FROM_ROOT] reached through the call to boot() at `index.js` line 2, then the call to send() at `src/boot.js` line 3; '
      + 'every step is shown as run, so this code runs when the postinstall lifecycle script runs `index.js`.');
    expect(trigger).toContain('For this group the call chain from the file load to the flagged code is confirmed.');
    expect(trigger).toContain('These statements on the way to the flagged code are supplied in `slices`:');
    expect(trigger).toContain('Count a CALLED_FROM_ROOT position as a shown call chain as well');
    // The path statements are request slices, and the Agent is given the same code.
    const slices = (run.request!.state as { slices: Array<{ sliceId: string; filePath: string; startLine: number; endLine: number }> }).slices;
    expect(slices.map((slice) => `${slice.sliceId.startsWith('EXECUTION-PATH-') ? 'PATH' : 'SLICE'} ${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual([
      'PATH src/send.js:2-2', 'SLICE src/send.js:3-3', 'PATH index.js:1-2', 'PATH src/boot.js:1-3',
    ]);
    expect(run.added).toEqual(['index.js:1-2', 'src/boot.js:1-3', 'src/send.js:2-2']);
    expect(run.outcome.record.executionPathStatements.map((item) => `${item.filePath}:${item.startLine}-${item.endLine}`)).toEqual(['index.js:1-2', 'src/boot.js:1-3', 'src/send.js:2-2']);
    expect(run.outcome.record.programIndex).toMatchObject({ status: 'BUILT', candidateFileCount: 3, parsedFileCount: 3, parseFailureCount: 0, appliedLimits: [] });
    expect(summarizeContextCheck(run.outcome.record)).toMatchObject({ programIndexStatus: 'BUILT', indexedFileCount: 3, confirmedTriggerPathCount: 1 });
    expect(JSON.stringify(summarizeContextCheck(run.outcome.record))).not.toContain('send.js');
  });

  it('changes only the TRIGGER question: the other questions are what they are without the index', async () => {
    const input = await executionFor(CHAIN, 'src/send.js');
    const withIndex = await runWith(input);
    const without = await runWith(input, {}, { programIndex: false });
    for (const context of ['INPUT', 'ACTION', 'TARGET', 'LINK'] as const) expect(withIndex.request!.questions[`G1__${context}`]).toEqual(without.request!.questions[`G1__${context}`]);
    expect(Object.keys(withIndex.request!.questions)).toEqual(Object.keys(without.request!.questions));
    expect(withIndex.question('TRIGGER')).not.toBe(without.question('TRIGGER'));
    const { slices: _slices, ...state } = withIndex.request!.state as Record<string, unknown>;
    const { slices: _other, ...baseline } = without.request!.state as Record<string, unknown>;
    expect(state).toEqual(baseline);
    expect(without.outcome.record.programIndex).toMatchObject({ status: 'NOT_REQUESTED' });
    expect(without.outcome.record.executionEvidence[0]!.findings[0]).not.toHaveProperty('reach');
    expect(CONTEXT_CHECK_LIMITS).toMatchObject({ visibleMinScore: 1.2, visibleMinConfidence: 0.3,
      strongVisibleMinScore: 1.5, strongVisibleMinConfidence: 0.2, missingMaxScore: 0.5, minConfidence: 0 });
    expect(withIndex.outcome.record.states).toEqual(without.outcome.record.states);
  });

  it.each([
    ['a timer', ['setTimeout(() => {', '  https.request(endpoint).end(); // FINDING', '}, 1000);'], 'TIMER_CALLBACK', 'CONFIRMED_ASYNC'],
    ['an outside event', ["process.on('exit', () => {", '  https.request(endpoint).end(); // FINDING', '});'], 'EXTERNAL_EVENT_CALLBACK', 'CONFIRMED_ASYNC'],
    ['an unknown callee', ['register(() => {', '  https.request(endpoint).end(); // FINDING', '});'], 'UNKNOWN_CALLBACK', 'CONFIRMED_ASYNC'],
    ['a then on an unknown promise', ['load().then(() => {', '  https.request(endpoint).end(); // FINDING', '});'], 'PROMISE_MICROTASK', 'PROBABLE'],
  ])('tells the model that a callback registered with %s runs when it fires, and takes TRIGGER as shown', async (_name, source, kind, evidence) => {
    const run = await runWith(await executionFor({ 'index.js': source }, 'index.js'), { TRIGGER: MISSING });
    const [finding] = run.outcome.record.executionEvidence[0]!.findings;
    expect(finding).toMatchObject({ position: 'CALLBACK', reach: { status: 'CONFIRMED', evidence, root: { kind: 'LIFECYCLE' } } });
    expect(finding!.reach!.steps.at(-1)).toMatchObject({ kind: 'CALLBACK', callbackKind: kind });
    const trigger = run.question('TRIGGER');
    expect(trigger).toContain('[CALLED_FROM_ROOT]');
    expect(trigger).toContain(evidence === 'PROBABLE' ? 'which runs once that promise settles; at least one step is likely rather than established' : 'which runs when its timer, event or operation fires');
    // Confirmed paths settle statically. A PROBABLE promise path still needs a qualifying Jev answer.
    expect(run.outcome.record.states.find((state) => state.context === 'TRIGGER')).toMatchObject({ state: 'MISSING' });
    if (evidence === 'PROBABLE') {
      expect(run.outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'TRIGGER' });
      expect(missing(run.outcome, 'TRIGGER')).toHaveLength(1);
    } else {
      expect(run.outcome.record.witnessResolved).toEqual([{ groupId: 'G1', context: 'TRIGGER' }]);
      expect(missing(run.outcome, 'TRIGGER')).toEqual([]);
    }
    expect(summarizeContextCheck(run.outcome.record).confirmedTriggerPathCount).toBe(1);
  });

  it('tells Tier 3 where a path starts when that is not the install or the package load', async () => {
    const starts = (run: Awaited<ReturnType<typeof runWith>>) => run.outcome.built.input.missingData.filter((item) => item.field === 'triggerStart').map((item) => item.reason);
    const timer = await runWith(await executionFor({ 'index.js': ['setTimeout(() => {', '  https.request(endpoint).end(); // FINDING', '}, 1000);'] }, 'index.js'));
    expect(starts(timer)).toEqual(['index.js (NETWORK_SEND): the path Scanner followed to this code starts at a callback that runs when its timer, event or operation fires. It is not shown to run at install by itself.']);
    const exported = await runWith(await executionFor({ 'index.js': ["require('./lib');"], 'lib.js': ['exports.send = function send() {', '  https.request(endpoint).end(); // FINDING', '};'] }, 'lib.js'));
    expect(starts(exported)).toEqual(['lib.js (NETWORK_SEND): the path Scanner followed to this code starts at the exported send, which a user of the package has to call. It is not shown to run at install by itself.']);
    // A path from the lifecycle script through direct calls needs no such note.
    expect(starts(await runWith(await executionFor(CHAIN, 'src/send.js')))).toEqual([]);
  });

  it('tells the model how a callback is run', async () => {
    const synchronous = await runWith(await executionFor({ 'index.js': ["['a', 'b'].forEach((name) => {", '  https.request(name).end(); // FINDING', '});'] }, 'index.js'));
    expect(synchronous.outcome.record.executionEvidence[0]!.findings[0]).toMatchObject({ position: 'CALLBACK', reach: { status: 'CONFIRMED' } });
    expect(synchronous.question('TRIGGER')).toContain('[CALLED_FROM_ROOT] reached through the callback handed over at `index.js` line 1, which is called before that call returns; '
      + 'every step is shown as run, so this code runs when the postinstall lifecycle script runs `index.js`.');
    const settled = await runWith(await executionFor({ 'index.js': ['Promise.resolve().then(() => {', '  https.request(endpoint).end(); // FINDING', '});'] }, 'index.js'));
    expect(settled.outcome.record.executionEvidence[0]!.findings[0]!.reach).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED_ASYNC', asyncBoundary: true });
    expect(settled.question('TRIGGER')).toContain('the callback handed to Promise.resolve().then() at `index.js` line 1, which runs right after the current run ends');
    expect(settled.question('TRIGGER')).toContain('one step completes just after the synchronous run');
    const stopped = await runWith(await executionFor({ 'index.js': ['Promise.resolve().then(() => {', '  https.request(endpoint).end(); // FINDING', '});', 'process.exit(0);'] }, 'index.js'));
    expect(stopped.outcome.record.executionEvidence[0]!.findings[0]!.reach).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE' });
    expect(stopped.question('TRIGGER')).toContain('at least one step is likely rather than established');
  });

  it('keeps a Finding that the single-file reading already shows as run exactly as it was', async () => {
    const files: Files = { 'index.js': ['function send() {', '  https.request(endpoint).end(); // FINDING', '}', 'send();'] };
    const input = await executionFor(files, 'index.js');
    const run = await runWith(input);
    const without = await runWith(input, {}, { programIndex: false });
    expect(run.outcome.record.executionEvidence[0]!.findings[0]).toMatchObject({ position: 'CALLED_AT_LOAD', reach: { status: 'CONFIRMED' } });
    expect(run.request).toEqual(without.request);
    expect(run.added).toEqual(expect.arrayContaining(without.added));
  });

  it('settles TRIGGER through the witness path once every statement of a confirmed path is in the slices', async () => {
    const input = await executionFor(CHAIN, 'src/send.js');
    // Without the path slices in the request, the path is added after the answer.
    const run = await runWith(input, { TRIGGER: MISSING }, { triggerEvidence: 'INSTRUCTION' });
    expect(traced(run.trace, 'TRIGGER').filter((entry) => entry.endsWith('selected')).length).toBeGreaterThan(0);
    expect(run.outcome.record.witnessPaths!.find((path) => path.context === 'TRIGGER')).toMatchObject({ complete: true, outcome: 'ADDED', depth: 2, confirmedEdgeCount: 2, probableEdgeCount: 0 });
    expect(run.added).toEqual(expect.arrayContaining(['index.js:1-2']));
    expect(missing(run.outcome, 'TRIGGER')).toEqual([]);
    expect(groupsWithWitnessedTrigger(run.outcome.record.executionEvidence, run.outcome.built.input.initialCodeSlices)).toEqual(new Set(['G1']));
    // The same path is not taken as shown while a statement of it is missing from the slices.
    expect(groupsWithWitnessedTrigger(run.outcome.record.executionEvidence, run.built.input.initialCodeSlices)).toEqual(new Set());
    expect(groupsWithWitnessedTrigger(run.outcome.record.executionEvidence, run.outcome.built.input.initialCodeSlices.filter((slice) => slice.filePath !== 'src/boot.js'))).toEqual(new Set());
  });

  it('follows a timer registration across files and takes TRIGGER as shown once the path is in the slices', async () => {
    const files: Files = {
      'index.js': ["const { later } = require('./later');", 'setTimeout(later, 1000);'],
      'later.js': ['exports.later = function later() {', '  https.request(endpoint).end(); // FINDING', '};'],
    };
    const run = await runWith(await executionFor(files, 'later.js'), { TRIGGER: MISSING });
    expect(run.outcome.record.executionEvidence[0]!.findings[0]!.reach).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED_ASYNC', limits: [], root: { kind: 'LIFECYCLE', filePath: 'index.js' } });
    expect(run.outcome.record.witnessPaths!.find((path) => path.context === 'TRIGGER')).toMatchObject({ complete: true });
    expect(run.added).toEqual(expect.arrayContaining(['index.js:1-2']));
    expect(run.question('TRIGGER')).toContain('[CALLED_FROM_ROOT]');
    expect(missing(run.outcome, 'TRIGGER')).toEqual([]);
    expect(groupsWithWitnessedTrigger(run.outcome.record.executionEvidence, run.outcome.built.input.initialCodeSlices)).toEqual(new Set(['G1']));
    expect(groupsWithWitnessedTrigger(run.outcome.record.executionEvidence, run.built.input.initialCodeSlices)).toEqual(new Set());
  });

  it('settles INPUT through a value flow across files and leaves an unresolved flow missing', async () => {
    const files: Files = {
      'index.js': ["const { collect } = require('./collect');", "const { send } = require('./send');", 'const data = collect();', 'send(data);'],
      'collect.js': ['exports.collect = function collect() {', '  return process.env;', '};'],
      'send.js': ['exports.send = function send(payload) {', '  https.request(endpoint).end(payload); // FINDING', '};'],
    };
    const run = await runWith(await executionFor(files, 'send.js'), { INPUT: MISSING });
    expect(run.outcome.record.inputWitnesses).toEqual([expect.objectContaining({ groupId: 'G1', findingId: FINDING, status: 'COMPLETE', unresolvedReasons: [] })]);
    // The TRIGGER path was supplied before the model was asked (index.js 4 and 2, send.js 1); the flow adds what is left of it.
    expect(traced(run.trace, 'INPUT').filter((entry) => entry.endsWith('selected'))).toEqual(['WITNESS_PATH index.js:3-3 selected', 'WITNESS_PATH index.js:1-1 selected', 'WITNESS_PATH collect.js:1-3 selected']);
    expect(run.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ complete: true, outcome: 'ADDED', newTargetCount: 3, newLineCount: 5 });
    expect(missing(run.outcome, 'INPUT')).toEqual([]);
    expect(summarizeContextCheck(run.outcome.record).completeInputFlowCount).toBe(1);
    const finalSlices = run.outcome.built.input.initialCodeSlices;
    expect(groupsWithWitnessedInput(run.outcome.record.inputWitnesses!, finalSlices)).toEqual(new Set(['G1']));
    // Both sides of every step have to be shown: without the file the value comes from, the flow is not taken as shown.
    expect(groupsWithWitnessedInput(run.outcome.record.inputWitnesses!, finalSlices.filter((slice) => slice.filePath !== 'collect.js'))).toEqual(new Set());

    // Nobody is seen to call the exported function, so where `payload` comes from is not known.
    const open = await runWith(await executionFor({ 'index.js': ["require('./send');"], 'send.js': files['send.js']! }, 'send.js'), { INPUT: MISSING });
    expect(open.outcome.record.inputWitnesses).toEqual([expect.objectContaining({ status: 'INCOMPLETE', unresolvedReasons: ['NO_CALLER_FOUND'] })]);
    expect(missing(open.outcome, 'INPUT')).toHaveLength(1);
  });

  /** `count` values, each declared on a line of its own with a blank line after it, all used by the Finding. */
  const spreadValues = (count: number): Files => {
    const body = Array.from({ length: count }, (_, index) => [`const v${index} = process.env.V${index};`, '']).flat();
    return { 'index.js': [...body, `https.request(endpoint).end([${Array.from({ length: count }, (_, index) => `v${index}`).join(', ')}]); // FINDING`] };
  };

  it('adds a path whole or not at all: the target budget', async () => {
    const fits = await runWith(await executionFor(spreadValues(11), 'index.js'), { INPUT: MISSING });
    expect(fits.added).toHaveLength(11);
    expect(fits.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ complete: true, outcome: 'ADDED', newTargetCount: 11, newLineCount: 11 });
    // With room for ten targets the path of eleven statements is not added as a path.
    const limits = { maxExpansionLines: 480, maxExpansionTargets: 10, maxLinesPerCandidate: 120 };
    const eleven = await runWith(await executionFor(spreadValues(11), 'index.js'), { INPUT: MISSING }, { measurementLimits: limits });
    expect(eleven.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ complete: true, outcome: 'NOT_ADDED', failureReason: 'TARGET_BUDGET', newTargetCount: 0, newLineCount: 0 });
    expect(eleven.added.length).toBeLessThanOrEqual(10);
    expect(summarizeContextCheck(eleven.outcome.record)).toMatchObject({ addedWitnessPathCount: 0, witnessPathFailures: { TARGET_BUDGET: 1 } });
  });

  it('adds a path whole or not at all: the line budget and the statement length limit', async () => {
    // Three lines are left for an expansion, and the flow needs four.
    const files: Files = { 'index.js': ['const a = process.env.A;', 'const b = process.env.B;', 'const c = process.env.C;', 'const d = process.env.D;', '', 'https.request(endpoint).end([a, b, c, d]); // FINDING'] };
    const policy = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxInitialCodeLines: 1, maxLinesPerSlice: 3, maxTotalCodeLines: 7 } };
    expect(expansionLineBudget(policy.codeSlices, 1)).toBe(3);
    const short = await runWith(await executionFor(files, 'index.js'), { INPUT: MISSING }, {}, policy);
    expect(short.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET' });
    // The direct lookup behind the path takes what the three lines hold.
    expect(short.outcome.record.addedLineCount).toBeLessThanOrEqual(3);
    const enough = await runWith(await executionFor(files, 'index.js'), { INPUT: MISSING });
    expect(enough.added).toEqual(['index.js:1-4']);
    // A statement longer than a candidate may be is not cut: the path that needs it is left out.
    const long: Files = { 'index.js': ['const table = {', ...Array.from({ length: 122 }, (_, index) => `  k${index}: process.env.K${index},`), '};', '', 'https.request(endpoint).end(table); // FINDING'] };
    const tooLong = await runWith(await executionFor(long, 'index.js'), { INPUT: MISSING });
    expect(tooLong.added).toEqual([]);
    expect(tooLong.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET' });
  });

  it('counts expansion targets apart from the INITIAL slice limit', async () => {
    const files = spreadValues(10);
    const input = await executionFor(files, 'index.js');
    // One INITIAL slice is all the regular limit allows; the expansion is counted on its own.
    const policy = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxInitialSlices: 1 } };
    const run = await runWith(input, { INPUT: MISSING }, {}, policy);
    expect(run.built.input.initialCodeSlices).toHaveLength(1);
    expect(run.added).toHaveLength(10);
    expect(run.outcome.record).toMatchObject({ status: 'EXPANDED', addedTargetCount: 10, addedSliceCount: 10, addedLineCount: 10 });
    expect(run.outcome.record.witnessPaths!.find((path) => path.context === 'INPUT')).toMatchObject({ outcome: 'ADDED', newTargetCount: 10, newLineCount: 10 });
    expect(expansionLineBudget(policy.codeSlices, 1)).toBe(480);
    expect(run.outcome.built.input.initialCodeSlices[0]).toEqual(run.built.input.initialCodeSlices[0]);
    // Without a slice limit of its own, a supplement still shares the regular limit.
    const expanded = { ...input, validatedPlan: { ...input.validatedPlan, targets: run.outcome.built.input.analysisPlan.targets } };
    expect((await build(expanded, { fromTargetIndex: 1, maxCodeLines: 120 }, policy)).input.initialCodeSlices).toHaveLength(1);
    expect((await build(expanded, { fromTargetIndex: 1, maxCodeLines: 120, maxSlices: 4 }, policy)).input.initialCodeSlices).toHaveLength(5);
    expect((await build(expanded, { fromTargetIndex: 1, maxCodeLines: 3, maxSlices: 10 }, policy)).input.initialCodeSlices).toHaveLength(4);
  });

  it('falls back to the file-by-file check when the index cannot be built, and stops when the scan is aborted', async () => {
    const input = await executionFor(CHAIN, 'src/send.js');
    const building = jest.spyOn(programIndexModule, 'buildPackageProgramIndex').mockRejectedValueOnce(new Error('index build failed'));
    const failed = await runWith(input, { TRIGGER: MISSING, INPUT: MISSING });
    expect(building).toHaveBeenCalledTimes(1);
    building.mockRestore();
    const without = await runWith(input, { TRIGGER: MISSING, INPUT: MISSING }, { programIndex: false });
    expect(failed.outcome.record.programIndex).toMatchObject({ status: 'UNAVAILABLE', parsedFileCount: 0, limitations: ['PROGRAM_INDEX_BUILD_FAILED'] });
    expect(failed.request).toEqual(without.request);
    expect(failed.added).toEqual(without.added);
    expect(failed.outcome.built.input.missingData).toEqual(without.outcome.built.input.missingData);
    expect(failed.outcome.record.status).toBe(without.outcome.record.status);

    const controller = new AbortController();
    controller.abort();
    await expect(runWith(input, {}, { signal: controller.signal })).rejects.toThrow();
  });

  describe('a path with probable steps', () => {
    // `run` is assigned again, so what `run()` calls is likely `send` but not established.
    const ALIASED: Files = { 'index.js': ['function send() {', '  https.request(endpoint).end(); // FINDING', '}', 'let run = send;', 'run = run;', 'run();'] };
    const reachOf = (run: Awaited<ReturnType<typeof runWith>>) => run.outcome.record.executionEvidence[0]!.findings[0]!.reach!;

    it('is followed, supplied before the model is asked and said to be likely', async () => {
      const run = await runWith(await executionFor(ALIASED, 'index.js'));
      expect(reachOf(run)).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 1, exploredDepth: 1, limits: [], root: { kind: 'LIFECYCLE' } });
      expect(run.question('TRIGGER')).toContain('[CALLED_FROM_ROOT] reached through the call to send() at `index.js` line 6; at least one step is likely rather than established');
      // The call and the alias it goes through are in the request and in the Agent input.
      expect(run.added).toEqual(expect.arrayContaining(['index.js:6-6', 'index.js:4-4']));
    });

    it('settles a PROBABLE TRIGGER only when its answer passes the score and confidence floor', async () => {
      const input = await executionFor(ALIASED, 'index.js');
      for (const answer of [MISSING, { score: 1, confidence: 0.2 }, { score: 1.2, confidence: 1 }, { score: 2, confidence: 0.39 }]) {
        const run = await runWith(input, { TRIGGER: answer });
        expect(run.outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'TRIGGER' });
        expect(missing(run.outcome, 'TRIGGER')).toHaveLength(1);
      }
      const accepted = await runWith(input, { TRIGGER: { score: 1.5, confidence: 0.4 } });
      expect(accepted.outcome.record.states.find((state) => state.context === 'TRIGGER')).toMatchObject({ state: 'VISIBLE' });
      expect(missing(accepted.outcome, 'TRIGGER')).toEqual([]);
      // Without room to show the path it stays reported.
      const policy = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxInitialCodeLines: 1, maxLinesPerSlice: 3, maxTotalCodeLines: 4 } };
      const none = await runWith(input, { TRIGGER: MISSING }, {}, policy);
      expect(none.added).toEqual([]);
      expect(missing(none.outcome, 'TRIGGER')).toHaveLength(1);
    });

    it('follows two probable steps and a chain of eleven calls', async () => {
      const twice: Files = { 'index.js': ['function send() {', '  https.request(endpoint).end(); // FINDING', '}', 'let first = send;', 'first = first;', 'function mid() {', '  first();', '}', 'let second = mid;', 'second = second;', 'second();'] };
      const double = await runWith(await executionFor(twice, 'index.js'));
      expect(reachOf(double)).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 2, limits: [] });
      const chain = ['function f0() {', '  https.request(endpoint).end(); // FINDING', '}'];
      for (let depth = 1; depth < 11; depth += 1) chain.push(`function f${depth}() {`, `  f${depth - 1}();`, '}');
      chain.push('f10();');
      const long = await runWith(await executionFor({ 'index.js': chain }, 'index.js'));
      expect(reachOf(long)).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', exploredDepth: 11, limits: [] });
      expect(summarizeContextCheck(long.outcome.record)).toMatchObject({ depthLimitedCount: 0, confirmedTriggerPathCount: 1 });
    });

    it('takes a value flow with probable edges as complete but keeps a low-score INPUT unresolved', async () => {
      // `box` is assigned again, so that `box.value` still holds the token is likely but not established.
      const files: Files = { 'index.js': ['let box = { value: process.env.TOKEN };', 'box = box;', 'https.request(endpoint).end(box.value); // FINDING'] };
      const run = await runWith(await executionFor(files, 'index.js'), { INPUT: MISSING });
      expect(run.outcome.record.inputWitnesses![0]).toMatchObject({ probableEdgeCount: 1, limits: [], unresolvedReasons: [] });
      expect(run.added).toEqual(['index.js:1-2']);
      expect(run.outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'INPUT' });
      expect(missing(run.outcome, 'INPUT')).toHaveLength(1);
      const twice: Files = { 'index.js': ['let a = { x: process.env.A };', 'a = a;', 'let b = { y: a.x };', 'b = b;', 'https.request(endpoint).end(b.y); // FINDING'] };
      const double = await runWith(await executionFor(twice, 'index.js'), { INPUT: MISSING });
      expect(double.outcome.record.inputWitnesses![0]).toMatchObject({ probableEdgeCount: 2, limits: [] });
      expect(missing(double.outcome, 'INPUT')).toHaveLength(1);
    });
  });

  describe('a path that starts where someone has to run or call the code', () => {
    const NET = { 'net.js': ["const https = require('https');", 'exports.post = function post(url) {', '  https.get(url);', '};'] };
    const EXPORTED: Files = { 'index.js': ["const { post } = require('./net');", 'exports.send = function send() {', '  post(endpoint); // FINDING', '};'], ...NET };
    const AT_LOAD: Files = { 'index.js': ["const { post } = require('./net');", 'function send() {', '  post(endpoint); // FINDING', '}', 'send();'], ...NET };
    const UNREFERENCED: Files = { 'index.js': ['module.exports = {};'], 'tool.js': ["const { post } = require('./net');", 'post(endpoint); // FINDING'], ...NET };
    const triggerOf = (run: Awaited<ReturnType<typeof runWith>>) => run.outcome.record.states.find((state) => state.context === 'TRIGGER')!;
    const settled = (run: Awaited<ReturnType<typeof runWith>>) => (run.outcome.record.witnessResolved ?? []).some((item) => item.context === 'TRIGGER');
    const rootOf = (run: Awaited<ReturnType<typeof runWith>>) => run.outcome.record.witnessPaths!.find((path) => path.context === 'TRIGGER')!.rootKind;
    const ASK = { lifecycleTriggerQuestion: 'ASK' as const };
    const partial = { score: 1, confidence: 1 };

    it('settles a path from a lifecycle script whatever the answer is', async () => {
      const run = await runWith(await executionFor(AT_LOAD, 'index.js'), { TRIGGER: partial }, ASK);
      expect(rootOf(run)).toBe('LIFECYCLE');
      expect(settled(run)).toBe(true);
      expect(missing(run.outcome, 'TRIGGER')).toEqual([]);
    });

    it.each([
      ['an exported function', EXPORTED, 'index.js', 'EXPORTED_API'],
      ['an unreferenced file', UNREFERENCED, 'tool.js', 'UNREFERENCED'],
    ] as const)('does not settle a path from %s on its own', async (_name, files, file, root) => {
      const low = await runWith(await executionFor(files, file), { TRIGGER: partial }, ASK);
      expect(rootOf(low)).toBe(root);
      expect(low.outcome.record.witnessPaths!.find((path) => path.context === 'TRIGGER')).toMatchObject({ complete: true, probableEdgeCount: 0 });
      expect(settled(low)).toBe(false);
      expect(triggerOf(low).state).toBe('PARTIAL');
      expect(missing(low.outcome, 'TRIGGER')).toHaveLength(1);
      // The path is confirmed, so the model's VISIBLE answer stands whatever its confidence.
      const agreed = await runWith(await executionFor(files, file), { TRIGGER: { score: 1.2, confidence: 0 } }, ASK);
      expect(triggerOf(agreed).state).toBe('VISIBLE');
      expect(missing(agreed.outcome, 'TRIGGER')).toEqual([]);
    });

    it('asks again with the final slices and takes the second answer', async () => {
      const second = async (answer: ScoreAnswer) => {
        const calls: ContextCheckRequest[] = [];
        let count = 0;
        const jev = { check: jest.fn(async (request: ContextCheckRequest) => {
          calls.push(request);
          count += 1;
          const rate = (key: string): ScoreAnswer => (count === 1 ? (key.endsWith('TRIGGER') ? partial : key.endsWith('ACTION') ? MISSING : VISIBLE) : key.endsWith('TRIGGER') ? answer : VISIBLE);
          return { model: 'jev-test', usage: { inputTokens: 1, outputTokens: 1 }, answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, rate(key)])) };
        }) };
        const run = await runWith(await executionFor(EXPORTED, 'index.js'), {}, { provider: jev, recheck: true, ...ASK });
        return { run, calls, trigger: run.outcome.record.recheck!.questions.find((question) => question.context === 'TRIGGER')! };
      };
      const yes = await second({ score: 1.6, confidence: 0.1 });
      expect(yes.calls).toHaveLength(2);
      expect(Object.keys(yes.calls[1]!.questions)).toContain('G1__TRIGGER');
      expect(yes.trigger).toMatchObject({ outcome: 'RESOLVED', unresolved: false, second: { state: 'VISIBLE' } });
      expect(missing(yes.run.outcome, 'TRIGGER')).toEqual([]);
      const no = await second({ score: 1.1, confidence: 1 });
      expect(no.trigger).toMatchObject({ outcome: 'IMPROVED_UNRESOLVED', unresolved: true });
      expect(missing(no.run.outcome, 'TRIGGER')).toHaveLength(1);
      expect(settled(no.run)).toBe(false);
    });
  });

  describe('questions the code cannot answer', () => {
    const omitted = (run: Awaited<ReturnType<typeof runWith>>) => run.outcome.record.omittedQuestions.map((item) => `${item.context} ${item.reason}`);
    const askedKeys = (run: Awaited<ReturnType<typeof runWith>>) => Object.keys(run.request!.questions);

    it('leaves out INPUT and LINK when the Finding is an operation call that passes literals only', async () => {
      const files: Files = { 'index.js': ["const https = require('https');", "https.get('https://example.test/ping'); // FINDING"] };
      const run = await runWith(await executionFor(files, 'index.js'));
      expect(omitted(run)).toEqual(['INPUT NO_TRACEABLE_VALUE', 'LINK NOTHING_TO_LINK']);
      expect(askedKeys(run)).toEqual(['G1__TRIGGER', 'G1__ACTION', 'G1__TARGET']);
      expect(run.outcome.record.states.map((state) => state.context)).toEqual(['TRIGGER', 'ACTION', 'TARGET']);
      expect(missing(run.outcome, 'INPUT')).toEqual([]);
      expect(summarizeContextCheck(run.outcome.record)).toMatchObject({ questionCount: 3, omittedQuestionCount: 2 });
    });

    it('reads a declaration that holds the literal-only call the same way', async () => {
      const files: Files = { 'index.js': ["const https = require('https');", "const request = https.get('https://example.test/ping', (response) => response.resume()); // FINDING"] };
      expect(omitted(await runWith(await executionFor(files, 'index.js')))).toEqual(['INPUT NO_TRACEABLE_VALUE', 'LINK NOTHING_TO_LINK']);
      const passed: Files = { 'index.js': ["const https = require('https');", 'const request = https.get(endpoint); // FINDING'] };
      expect(omitted(await runWith(await executionFor(passed, 'index.js')))).toEqual([]);
    });

    it('leaves out INPUT only when the literal-only call goes through a wrapper', async () => {
      const files: Files = { 'index.js': ["const https = require('https');", 'function ping() {', "  https.get('https://example.test/ping');", '}', 'ping(); // FINDING'] };
      const run = await runWith(await executionFor(files, 'index.js'));
      expect(omitted(run)).toEqual(['INPUT NO_TRACEABLE_VALUE']);
      expect(askedKeys(run)).toContain('G1__LINK');
    });

    it('asks every question when a value is passed or the index is off; a callback is not a value', async () => {
      const passed: Files = { 'index.js': ["const https = require('https');", 'const data = process.env.TOKEN;', 'https.request(endpoint).end(data); // FINDING'] };
      expect(omitted(await runWith(await executionFor(passed, 'index.js')))).toEqual([]);
      const literal: Files = { 'index.js': ["const https = require('https');", "https.get('https://example.test/ping'); // FINDING"] };
      expect(omitted(await runWith(await executionFor(literal, 'index.js'), {}, { programIndex: false }))).toEqual([]);
      const callback: Files = { 'index.js': ["const https = require('https');", "https.get('https://example.test/ping', (response) => response.resume()); // FINDING"] };
      expect(omitted(await runWith(await executionFor(callback, 'index.js')))).toEqual(['INPUT NO_TRACEABLE_VALUE', 'LINK NOTHING_TO_LINK']);
    });
  });

  describe('where a value read from the environment goes', () => {
    const ENV_RULE = 'custom.collection-source';
    async function envRun(lines: string[], answers: Parameters<typeof runWith>[1] = {}) {
      const input = await executionFor({ 'index.js': lines }, 'index.js');
      input.findings[0]!.ruleId = ENV_RULE;
      input.findingAttributes = { [input.findings[0]!.findingId]: { sourceType: 'ENVIRONMENT_VARIABLE' } };
      return runWith(input, answers);
    }
    const linkOf = (run: Awaited<ReturnType<typeof envRun>>) => run.outcome.record.witnessPaths!.find((path) => path.context === 'LINK' && path.sink?.callee === 'process.env.MODE')!;

    it('asks only TRIGGER and LINK, with wording of its own', async () => {
      const run = await envRun(['const mode = process.env.MODE; // FINDING', "if (mode === 'debug') console.log('debug');"]);
      expect(Object.keys(run.request!.questions)).toEqual(['G1__TRIGGER', 'G1__LINK']);
      expect(run.question('LINK')).toContain('Is it visible where the value read from the environment variable is used afterwards?');
    });

    it('is complete when the value is consumed where it is read', async () => {
      const run = await envRun(["if (process.env.MODE === 'debug') console.log('debug'); // FINDING"]);
      expect(linkOf(run)).toMatchObject({ complete: true, depth: 0 });
      expect(missing(run.outcome, 'LINK')).toEqual([]);
    });

    it('follows a constant name to every statement that uses it and adds the ones the slices lack', async () => {
      const run = await envRun([
        "const https = require('https');", 'const mode = process.env.MODE; // FINDING', 'function report() {', "  https.get('https://example.test/?m=' + mode);", '}',
        "if (mode !== 'off') report();",
      ], { LINK: MISSING });
      expect(linkOf(run)).toMatchObject({ complete: true, outcome: 'ADDED' });
      expect(linkOf(run).steps.map((step) => `${step.kind} ${step.statement.startLine}`)).toEqual(['INITIALIZER 2', 'USE 4', 'USE 6']);
      expect(run.added).toEqual(expect.arrayContaining(['index.js:4-4', 'index.js:6-6']));
      expect(run.outcome.record.witnessResolved).toContainEqual({ groupId: 'G1', context: 'LINK' });
    });

    it('ends at the read, not at a call on the same line, and follows a literal into the call that takes it', async () => {
      const run = await envRun(["const logger = require('winston');", 'logger.createLogger({ level: process.env.MODE, tags: [process.env.MODE] }); // FINDING']);
      const links = run.outcome.record.witnessPaths!.filter((path) => path.context === 'LINK');
      expect(links.map((path) => path.sink?.callee).sort()).toEqual(['process.env', 'process.env.MODE']);
      expect(links.every((path) => path.complete && path.depth === 0)).toBe(true);
      // A literal held by a constant name is followed like the name itself.
      const stored = await envRun(['const config = { level: process.env.MODE }; // FINDING', 'console.log(config);'], { LINK: MISSING });
      expect(linkOf(stored).steps.map((step) => `${step.kind} ${step.statement.startLine}`)).toEqual(['INITIALIZER 1', 'USE 2']);
      expect(linkOf(stored)).toMatchObject({ complete: true });
    });

    describe('through other holders', () => {
      const steps = (run: Awaited<ReturnType<typeof envRun>>) => linkOf(run).steps.map((step) => `${step.kind} ${step.evidence} ${step.statement.startLine}`);
      const HTTPS = "const https = require('https');";

      it('follows a name made from the name, and what a for...of hands on', async () => {
        const run = await envRun([
          HTTPS, "const raw = process.env.MODE || ''; // FINDING", "const parts = raw.split(',').filter(Boolean);", 'if (!parts.length) process.exit(1);',
          'for (const part of parts) https.get(part);',
        ], { LINK: MISSING });
        expect(linkOf(run)).toMatchObject({ complete: true, probableEdgeCount: 0 });
        expect(steps(run)).toEqual(['INITIALIZER CONFIRMED 2', 'INITIALIZER CONFIRMED 3', 'USE CONFIRMED 4', 'INITIALIZER CONFIRMED 5']);
      });

      it.each([
        ['is handed on a fourth time', [HTTPS, 'const a = process.env.MODE; // FINDING', 'const b = a.trim();', 'const c = b.trim();', 'const d = c.trim();', 'https.get(d);']],
        ['is returned on the way', [HTTPS, 'const a = process.env.MODE; // FINDING', 'function b() {', '  const c = a.trim();', '  return c;', '}', 'https.get(b());']],
        ['is used in more than eight statements', [HTTPS, 'const a = process.env.MODE; // FINDING', ...Array.from({ length: 9 }, (_item, index) => `https.get(a, ${index});`)]],
      ])('stays incomplete when the value %s', async (_name, lines) => {
        expect(linkOf(await envRun(lines, { LINK: MISSING }))).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
      });

      const CLIENT = (...body: string[]) => [HTTPS, 'class Client {', '  constructor(token) {', '    this.token = token ?? process.env.MODE; // FINDING', '  }', ...body, '}', 'new Client().send();'];
      const send = ['  send() {', "    const headers = { Authorization: `Bearer ${this.token}` };", "    https.get('https://example.test', { headers });", '  }'];

      it('follows an instance field to where the class reads it, as a probable step', async () => {
        const run = await envRun(CLIENT(...send), { LINK: MISSING });
        expect(linkOf(run)).toMatchObject({ complete: true, probableEdgeCount: 1 });
        expect(steps(run)).toEqual(['PROPERTY_WRITE PROBABLE 4', 'INITIALIZER CONFIRMED 7', 'USE CONFIRMED 8']);
        // A probable step is never settled by Scanner alone.
        expect(run.outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'LINK' });
      });

      it.each([
        ['is written twice', CLIENT(...send, '  reset() {', '    this.token = null;', '  }')],
        ['may be written under a computed name', CLIENT(...send, '  set(name, value) {', '    this[name] = value;', '  }')],
        ['belongs to a class that is extended', [...CLIENT(...send), 'class Other extends Client {}']],
        ['is returned by a method', CLIENT('  send() {', '    return this.token;', '  }')],
      ])('stays incomplete when the field %s', async (_name, lines) => {
        expect(linkOf(await envRun(lines, { LINK: MISSING }))).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
      });
    });

    it('takes a write to an environment variable as used where it stands', async () => {
      const written = await envRun(["process.env.MODE = 'debug'; // FINDING"]);
      expect(linkOf(written)).toMatchObject({ complete: true, depth: 0 });
      const appended = await envRun(['process.env.MODE = `${extra}:${process.env.MODE}`; // FINDING']);
      expect(appended.outcome.record.witnessPaths!.filter((path) => path.context === 'LINK').every((path) => path.complete)).toBe(true);
    });

    it('counts a statement as shown when only its closing line is outside the slices', async () => {
      const lines = ['const mode = process.env.MODE; // FINDING', 'register({', '  mode,', '});'];
      const input = await executionFor({ 'index.js': lines }, 'index.js');
      input.findings[0]!.ruleId = ENV_RULE;
      input.findingAttributes = { [input.findings[0]!.findingId]: { sourceType: 'ENVIRONMENT_VARIABLE' } };
      // The slice ends one line before the closing `});` of the statement that uses the value.
      input.validatedPlan.targets[0]!.preferredRange = { startLine: 1, endLine: 3 };
      const run = await runWith(input);
      expect(run.built.input.initialCodeSlices.map((slice) => [slice.startLine, slice.endLine])).toEqual([[1, 3]]);
      expect(run.outcome.record.states.find((state) => state.context === 'LINK')).toMatchObject({ state: 'VISIBLE' });
    });

    it('is not complete when the value leaves through a return, a property or a reassigned name', async () => {
      for (const lines of [
        ['function mode() {', '  return process.env.MODE; // FINDING', '}'],
        ['const config = {};', 'config.mode = process.env.MODE; // FINDING'],
        ['let mode = process.env.MODE; // FINDING', "mode = mode || 'x';", 'console.log(mode);'],
        ['const mode = process.env.MODE; // FINDING', 'module.exports = { mode };'],
      ]) {
        const run = await envRun(lines, { LINK: MISSING });
        expect(linkOf(run)).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
        expect(missing(run.outcome, 'LINK')).toHaveLength(1);
      }
    });

    it('does not follow a value used in more than eight statements', async () => {
      const run = await envRun(['const mode = process.env.MODE; // FINDING', ...Array.from({ length: 9 }, (_, index) => `console.log(mode, ${index});`)], { LINK: MISSING });
      expect(linkOf(run)).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
    });
  });

  describe('witness paths of every context', () => {
    const WRAPPED: Files = {
      'index.js': ["const { upload } = require('./net');", 'const data = process.env.TOKEN;', 'upload(data); // FINDING'],
      'net.js': ["const https = require('https');", "const HOST = 'https://example.test';", 'function post(payload) {', '  https.request(HOST).end(payload);', '}', 'exports.upload = function upload(value) {', '  post(value);', '};'],
    };
    const pathOf = (run: Awaited<ReturnType<typeof runWith>>, context: ContextCode) => run.outcome.record.witnessPaths!.find((path) => path.context === context)!;

    it('adds the whole way from the Finding to the operation API for ACTION', async () => {
      const run = await runWith(await executionFor(WRAPPED, 'index.js'), { ACTION: MISSING });
      // The require that names the wrapper, each wrapper's declaration and call (6-7, 3), and the call of the API (4).
      expect(pathOf(run, 'ACTION')).toMatchObject({ complete: true, outcome: 'ADDED', depth: 2, confirmedEdgeCount: 2, probableEdgeCount: 0, newTargetCount: 3 });
      expect(pathOf(run, 'ACTION').newLineCount).toBeGreaterThan(0);
      // The direct lookup behind the path holds nothing the path did not add.
      expect(traced(run.trace, 'ACTION').filter((entry) => entry.endsWith('selected'))).toEqual(expect.arrayContaining([
        'WITNESS_PATH index.js:1-1 selected', 'WITNESS_PATH net.js:6-7 selected', 'WITNESS_PATH net.js:3-4 selected',
      ]));
      expect(run.added).toEqual(expect.arrayContaining(['index.js:1-1', 'net.js:6-7']));
      expect(missing(run.outcome, 'ACTION')).toEqual([]);
      // The questions are what they are without the index: only the code that is added differs.
      const without = await runWith(await executionFor(WRAPPED, 'index.js'), { ACTION: MISSING }, { programIndex: false });
      expect(run.request!.questions).toEqual(without.request!.questions);
    });

    it('adds TARGET and LINK paths from the arguments of that call, counting shared statements once', async () => {
      const run = await runWith(await executionFor(WRAPPED, 'index.js'), { ACTION: MISSING, TARGET: MISSING, LINK: MISSING });
      for (const context of ['ACTION', 'TARGET', 'LINK'] as const) expect(pathOf(run, context)).toMatchObject({ complete: true });
      expect(missing(run.outcome, 'ACTION')).toEqual([]);
      expect(missing(run.outcome, 'TARGET')).toEqual([]);
      // The index records a LINK path, but it is not an exact witness for every Finding in the group.
      expect(missing(run.outcome, 'LINK')).toHaveLength(1);
      // Every line is added once, whichever paths need it.
      const lines = run.outcome.built.input.initialCodeSlices.slice(1).flatMap((slice) => Array.from({ length: slice.endLine - slice.startLine + 1 }, (_, offset) => `${slice.filePath}:${slice.startLine + offset}`));
      expect(new Set(lines).size).toBe(lines.length);
      // INPUT is rated VISIBLE and the Finding's statement is in the slices, so its source (index.js:2) is not looked up.
      expect([...lines].sort()).toEqual(['index.js:1', 'net.js:2', 'net.js:3', 'net.js:4', 'net.js:6', 'net.js:7']);
      const added = run.outcome.record.witnessPaths!.filter((path) => path.outcome === 'ADDED');
      // Every added line belongs to a witness path.
      expect(added.reduce((sum, path) => sum + path.newLineCount, 0)).toBe(run.outcome.record.addedLineCount);
      expect(summarizeContextCheck(run.outcome.record)).toMatchObject({ addedWitnessPathCount: 2, witnessPathFailures: {} });
    });

    it('uses the direct lookup only for a context without a complete path', async () => {
      // The wrapper calls an external library, which is not an operation API by its name alone.
      const files: Files = { 'index.js': ["const agent = require('private-agent');", 'function send(data) {', '  agent.post(url, data);', '}', 'send(1); // FINDING'] };
      const run = await runWith(await executionFor(files, 'index.js'), { ACTION: MISSING });
      expect(pathOf(run, 'ACTION')).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY', outcome: 'NOT_ADDED' });
      expect(traced(run.trace, 'ACTION')).toEqual(['LOCAL_FUNCTION index.js:2-4 selected']);
      expect(run.added).toEqual(['index.js:2-4']);
      expect(summarizeContextCheck(run.outcome.record)).toMatchObject({ witnessPathFailures: { EXTERNAL_BOUNDARY: 3 } });
    });

    it('records a selected witness omitted by the rebuilt slices as a slice error, not a confidence failure', async () => {
      const input = await executionFor(WRAPPED, 'index.js');
      const built = await build(input);
      const run = await runWith(input, { ACTION: MISSING }, { rebuild: async () => built });
      expect(run.outcome.record.witnessSliceErrors).toEqual(expect.arrayContaining([
        expect.objectContaining({ groupId: 'G1', context: 'ACTION', reason: 'SELECTED_WITNESS_NOT_IN_SLICES' }),
      ]));
      expect(missing(run.outcome, 'ACTION')).toHaveLength(1);
    });

    it('adds nothing for a path that is already in the slices', async () => {
      const files: Files = { 'index.js': ["const https = require('https');", "https.request('https://example.test').end(); // FINDING"] };
      const run = await runWith(await executionFor(files, 'index.js'), { ACTION: MISSING, TARGET: MISSING });
      expect(pathOf(run, 'ACTION')).toMatchObject({ complete: true, outcome: 'ALREADY_IN_SLICES', newTargetCount: 0, newLineCount: 0 });
      expect(pathOf(run, 'TARGET')).toMatchObject({ complete: true, outcome: 'ALREADY_IN_SLICES' });
      expect(traced(run.trace, 'ACTION').filter((entry) => entry.startsWith('WITNESS_PATH'))).toEqual([]);
      // The path lies in the slices, so the context is taken as shown.
      expect(missing(run.outcome, 'ACTION')).toEqual([]);
      expect(run.outcome.record.witnessResolved).toEqual(expect.arrayContaining([{ groupId: 'G1', context: 'ACTION' }, { groupId: 'G1', context: 'TARGET' }]));
    });

    it('takes the shorter path first when both do not fit', async () => {
      // LINK needs the whole chain; TARGET needs one line. With four lines left, only what fits whole is added.
      const policy = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxInitialCodeLines: 1, maxLinesPerSlice: 4, maxTotalCodeLines: 9 } };
      expect(expansionLineBudget(policy.codeSlices, 1)).toBe(4);
      const run = await runWith(await executionFor(WRAPPED, 'index.js'), { TARGET: MISSING, LINK: MISSING }, {}, policy);
      expect(pathOf(run, 'TARGET')).toMatchObject({ complete: true, outcome: 'ADDED' });
      expect(pathOf(run, 'LINK')).toMatchObject({ complete: true, outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET' });
      expect(run.outcome.record.addedLineCount).toBeLessThanOrEqual(4);
      expect(CONTEXT_CHECK_LIMITS).toMatchObject({ maxExpansionLines: 480, maxExpansionTargets: 80, maxLinesPerCandidate: 120, visibleMinScore: 1.2, missingMaxScore: 0.5 });
    });
  });

  it('records what the index could not read and keeps checking with the rest', async () => {
    const files: Files = { ...CHAIN, 'broken.js': ['function ( {'], 'src/other.js': ['require(name);'] };
    const run = await runWith(await executionFor(files, 'src/send.js'));
    expect(run.outcome.record.programIndex).toMatchObject({ status: 'BUILT', candidateFileCount: 5, parsedFileCount: 4, parseFailureCount: 1, unresolvedModuleEdgeCount: 1 });
    expect(run.outcome.record.programIndex!.limitations).toEqual(expect.arrayContaining(['PARSE_FAILURES', 'UNRESOLVED_MODULE_EDGES']));
    expect(run.outcome.record.executionEvidence[0]!.findings[0]!.reach).toMatchObject({ status: 'CONFIRMED' });
    expect(summarizeContextCheck(run.outcome.record)).toMatchObject({ programIndexStatus: 'BUILT', parseFailureCount: 1 });
  });

  describe('several witness paths of one context', () => {
    const pathText = (path: ContextWitnessPath) => `${path.context} ${path.findingId} rank=${path.rank} ${path.outcome}${path.exclusionReason === undefined ? '' : ` ${path.exclusionReason}`}`;
    const SINKS: Files = {
      'index.js': [
        "const https = require('https');", 'function probe(url) {', '  https.get(url);', '}', 'function post(url) {', "  https.request(url).end('x');", '}',
        'function both(url) {', '  probe(url);', '  post(url);', '}', "both('https://example.test'); // FINDING",
      ],
    };

    it('adds the paths to every operation call the Finding leads to and records how each was chosen', async () => {
      const run = await runWith(await executionFor(SINKS, 'index.js'), { ACTION: MISSING });
      const actions = run.outcome.record.witnessPaths!.filter((path) => path.context === 'ACTION');
      expect(actions.map(pathText)).toEqual([`ACTION ${FINDING} rank=1 ADDED`, `ACTION ${FINDING} rank=2 ADDED`]);
      expect(actions.map((path) => `${path.pathId} ${path.sink?.callee}@${path.sink?.startLine}`))
        .toEqual(['WP-3 https.get@3', 'WP-4 https.request@6']);
      expect(actions.every((path) => path.selectionOrder !== undefined && path.newLineCount > 0 && path.newTargetCount > 0)).toBe(true);
      expect(actions.every((path) => path.complete && path.confirmedAsyncEdgeCount === 0)).toBe(true);
      // The second path adds only what the first did not: its own call and wrapper.
      expect(run.added).toEqual(['index.js:8-9', 'index.js:2-3', 'index.js:8-11', 'index.js:5-6']);
      expect(traced(run.trace, 'ACTION').filter((entry) => entry.startsWith('WITNESS_PATH')).every((entry) => entry.endsWith('selected'))).toBe(true);
      expect(missing(run.outcome, 'ACTION')).toEqual([]);
    });

    it('adds the complete path first and offers what was found of an incomplete one', async () => {
      const files: Files = {
        'index.js': ["const { send } = require('./src/net');", 'const token = process.env.TOKEN;', 'send(token);'],
        'src/net.js': [
          "const https = require('https');", 'exports.send = function send(value) {', "  https.request('https://example.test').end(value); // FINDING", '};',
          'exports.relay = function relay(other) {', "  https.request('https://example.test').end(other); // SECOND", '};',
        ],
      };
      const input = await executionFor(files, 'src/net.js');
      const second = lineOf(files, 'src/net.js', 'SECOND');
      input.findings.push({ ...input.findings[0]!, findingId: 'F:second', location: { file: 'src/net.js', startLine: second, endLine: second } });
      input.bindings.findingBindings.push({ ...input.bindings.findingBindings[0]!, findingId: 'F:second', startLine: second, endLine: second });
      input.validatedPlan.targets[0]!.findingRefs.push('F:second');
      const run = await runWith(input, { INPUT: MISSING });
      const inputs = run.outcome.record.witnessPaths!.filter((path) => path.context === 'INPUT');
      expect(inputs.map(pathText)).toEqual([`INPUT ${FINDING} rank=1 ADDED`, 'INPUT F:second rank=undefined OFFERED_INCOMPLETE EXTERNAL_BOUNDARY']);
      expect(traced(run.trace, 'INPUT')[0]).toBe('WITNESS_PATH index.js:2-2 selected');
      // Every Finding of the group needs an exact witness; the incomplete second Finding keeps INPUT open.
      expect(run.outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'INPUT' });
      expect(missing(run.outcome, 'INPUT')).toHaveLength(1);
    });
  });

  describe('second check with the final slices', () => {
    const SINKS: Files = {
      'index.js': [
        "const https = require('https');", 'function probe(url) {', '  https.get(url);', '}', 'function post(url) {', "  https.request(url).end('x');", '}',
        'function both(url) {', '  probe(url);', '  post(url);', '}', 'both(endpoint); // FINDING',
      ],
    };
    type Answers = Partial<Record<string, ScoreAnswer>>;
    /** Answers the n-th call with the n-th entry (the last one for every later call); an Error entry is thrown. */
    function sequence(...calls: Array<Answers | Error | (() => never)>) {
      let count = 0;
      const check = jest.fn(async (request: ContextCheckRequest) => {
        const entry = calls[Math.min(count, calls.length - 1)]!;
        count += 1;
        if (entry instanceof Error) throw entry;
        if (typeof entry === 'function') return entry();
        return {
          model: 'jev-test', usage: { inputTokens: 100, outputTokens: 10 },
          answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, entry[key.split('__')[1] ?? ''] ?? VISIBLE])),
        };
      });
      return { check };
    }
    const recheckWith = async (jev: ReturnType<typeof sequence>, input?: Tier3ExecutionInput, options: Partial<ContextCheckInput> = {}) => {
      const run = await runWith(input ?? await executionFor(SINKS, 'index.js'), {}, { provider: jev, recheck: true, ...options });
      return { ...run, calls: jev.check.mock.calls.map(([request]) => request), recheck: run.outcome.record.recheck };
    };
    const asked = (questions: readonly { context: ContextCode; outcome: string; unresolved: boolean }[] = []) => questions.map((item) => `${item.context} ${item.outcome}${item.unresolved ? ' unresolved' : ''}`);

    it('makes one call and records nothing while the second check is off', async () => {
      const off = sequence({ ACTION: MISSING });
      const run = await runWith(await executionFor(SINKS, 'index.js'), {}, { provider: off });
      const on = await recheckWith(sequence({ ACTION: MISSING }, new ContextCheckProviderError('down', 'TRANSPORT')));
      expect(off.check).toHaveBeenCalledTimes(1);
      expect(run.outcome.record).not.toHaveProperty('recheck');
      expect(summarizeContextCheck(run.outcome.record)).not.toHaveProperty('recheckCallCount');
      // What the Agent receives without the second check is what it receives when the second check gives no answer.
      expect(on.outcome.built.input).toEqual(run.outcome.built.input);
    });

    it('asks again only about the context code was added for, with the same question and the final slices', async () => {
      const { calls, recheck, outcome, added } = await recheckWith(sequence({ INPUT: MISSING }, {}), undefined, { recheckVerifyScannerSettled: true });
      // Unless a measurement run asks for it, what Scanner settled is not asked about again.
      const plain = await recheckWith(sequence({ INPUT: MISSING }, {}));
      expect(Object.keys((plain.calls[1] as ContextCheckRequest).questions)).toEqual(['G1__INPUT']);
      expect(plain.recheck).not.toHaveProperty('scannerSettled');
      expect(calls).toHaveLength(2);
      const [first, second] = calls as [ContextCheckRequest, ContextCheckRequest];
      expect(Object.keys(first.questions).length).toBeGreaterThan(1);
      // LINK was settled by the path Scanner added; it is asked along for the record and changes nothing.
      expect(Object.keys(second.questions)).toEqual(['G1__INPUT', 'G1__LINK']);
      expect(recheck!.scannerSettled).toEqual([{ groupId: 'G1', context: 'LINK', first: { score: 2, confidence: 1 }, second: { score: 2, confidence: 1 }, agreed: true }]);
      expect(recheck!.questions.map((question) => question.context)).toEqual(['INPUT']);
      expect(summarizeContextCheck(outcome.record)).toMatchObject({ recheckQuestionCount: 1, scannerSettledChecked: 1, scannerSettledAgreed: 1 });
      // The question is the first one plus where code was added for the group; nothing else differs.
      expect(second.questions.G1__INPUT).toEqual({ ...first.questions.G1__INPUT, instructions: expect.stringContaining(first.questions.G1__INPUT!.instructions) });
      expect(second.questions.G1__INPUT!.instructions.slice(first.questions.G1__INPUT!.instructions.length))
        .toBe(' Since the first rating, code was added for this Finding group at `index.js` lines 2-3, `index.js` lines 5-6, `index.js` lines 8-11; rate what all the supplied slices show now.');
      const state = second.state as { groups: unknown[]; slices: Array<{ sliceId: string; filePath: string; startLine: number; endLine: number }> };
      expect(state.groups).toEqual((first.state as { groups: unknown[] }).groups);
      // The slices are the ones the Agent receives, in line order; nothing of the first answer is sent.
      expect(state.slices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`)).toEqual(['index.js:2-3', 'index.js:5-6', 'index.js:8-11', 'index.js:12-12']);
      expect(state.slices.map((slice) => slice.sliceId).sort()).toEqual(outcome.built.input.initialCodeSlices.map((slice) => slice.sliceId).sort());
      expect(JSON.stringify(second.state)).not.toMatch(/MISSING|PARTIAL|VISIBLE|"score"|"confidence"/u);
      expect(JSON.stringify(second)).not.toContain('EXECUTION-PATH');
      expect(added).toHaveLength(3);
      // The Finding's whole statement is in the slices, so the second VISIBLE answer settles INPUT.
      expect(asked(recheck!.questions)).toEqual(['INPUT RESOLVED']);
      expect(recheck!.questions[0]).toMatchObject({ reason: 'CODE_ADDED', first: { score: 0, confidence: 1, state: 'MISSING' }, second: { score: 2, confidence: 1, state: 'VISIBLE' } });
      expect(missing(outcome, 'INPUT')).toEqual([]);
      // The first answers stay as they were.
      expect(outcome.record.states.find((item) => item.context === 'INPUT')).toMatchObject({ state: 'MISSING', score: 0 });
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 0 });
    });

    it.each([
      ['UNRESOLVED', MISSING, MISSING],
      ['IMPROVED_UNRESOLVED', MISSING, { score: 1, confidence: 1 }],
      ['REGRESSED', { score: 1, confidence: 1 }, MISSING],
    ] as const)('records a second answer that is %s and keeps the context open', async (expected, firstAnswer, secondAnswer) => {
      const { recheck, outcome, added } = await recheckWith(sequence({ INPUT: firstAnswer }, { INPUT: secondAnswer }));
      expect(asked(recheck!.questions)).toEqual([`INPUT ${expected} unresolved`]);
      expect(outcome.record.witnessResolved ?? []).not.toContainEqual({ groupId: 'G1', context: 'INPUT' });
      expect(missing(outcome, 'INPUT')).toHaveLength(1);
      expect(outcome.record).toMatchObject({ status: 'EXPANDED', unresolvedContextCount: 1 });
      // The added code goes to the Agent whatever the second answer is.
      expect(added).toHaveLength(3);
    });

    it('takes a second VISIBLE answer on direct evidence whatever its confidence', async () => {
      const { recheck, outcome } = await recheckWith(sequence({ INPUT: MISSING }, { INPUT: { score: 1.2, confidence: 0 } }));
      expect(asked(recheck!.questions)).toEqual(['INPUT RESOLVED']);
      expect(missing(outcome, 'INPUT')).toEqual([]);
    });

    it('without a complete path, settles ACTION on direct evidence and leaves LINK open', async () => {
      // The wrapper calls an external library, which is not an operation API by its name alone.
      const files: Files = { 'index.js': ["const agent = require('private-agent');", 'function send(data) {', '  agent.post(url, data);', '}', 'send(1); // FINDING'] };
      const open = await recheckWith(sequence({ ACTION: MISSING }, { ACTION: MISSING }), await executionFor(files, 'index.js'));
      // INPUT and TARGET were rated VISIBLE on the Finding's own statement; ACTION and LINK are open.
      // No answer could settle LINK without a path, so it is not asked again; it stays open.
      expect(asked(open.recheck!.questions)).toEqual(['ACTION UNRESOLVED unresolved']);
      expect(open.recheck).toMatchObject({ skippedUnsettleable: 1 });
      expect(Object.keys((open.calls[1] as ContextCheckRequest).questions)).toEqual(['G1__ACTION']);
      expect(missing(open.outcome, 'ACTION')).toHaveLength(1);
      expect(missing(open.outcome, 'LINK')).toHaveLength(1);
      const settled = await recheckWith(sequence({ ACTION: MISSING }, {}), await executionFor(files, 'index.js'));
      // A second VISIBLE answer settles ACTION on the Finding's own statement; LINK needs a complete path and stays open.
      expect(asked(settled.recheck!.questions)).toEqual(['ACTION RESOLVED']);
      expect(missing(settled.outcome, 'ACTION')).toEqual([]);
      expect(missing(settled.outcome, 'LINK')).toHaveLength(1);
    });

    describe('a value flow that reaches the operation while one origin stays open', () => {
      // `name` is followed to the request by confirmed steps; `extra` comes from whoever calls the exported function.
      const OPEN: Files = {
        'index.js': ["const https = require('https');", "const os = require('os');", 'function send(extra) {', '  const name = os.hostname();', '  const body = name + extra;',
          "  https.get('https://example.test/?q=' + body); // FINDING", '}', 'module.exports = send;'],
      };
      const link = async (...answers: Array<Partial<Record<string, ScoreAnswer>>>) => {
        const run = await recheckWith(sequence(...(answers as [Partial<Record<string, ScoreAnswer>>])), await executionFor(OPEN, 'index.js'));
        const path = run.outcome.record.witnessPaths?.find((item) => item.context === 'LINK');
        return { ...run, path, open: missing(run.outcome, 'LINK').length };
      };

      it('keeps the path incomplete and lets a sure enough answer settle LINK', async () => {
        const settled = await link({}, {});
        expect(settled.path).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY', probableEdgeCount: 0 });
        expect(settled.path!.steps.length).toBeGreaterThan(0);
        // The first answer was given before the flow's statements were in the slices; once they are, it counts.
        expect(settled.outcome.record.states.find((item) => item.context === 'LINK')).toMatchObject({ state: 'PARTIAL' });
        expect(settled.outcome.record.witnessResolved).toContainEqual({ groupId: 'G1', context: 'LINK' });
        expect(settled.open).toBe(0);
        const again = await link({ LINK: { score: 1.1, confidence: 1 } }, { LINK: { score: 1.3, confidence: 0.3 } });
        expect(asked(again.recheck!.questions)).toContain('LINK RESOLVED');
        expect(again.open).toBe(0);
      });

      it.each([
        ['a score under 1.2', { score: 1.1, confidence: 1 }],
        ['too little confidence', { score: 1.3, confidence: 0.2 }],
      ])('leaves LINK open on %s', async (_name, answer) => {
        expect((await link({ LINK: answer }, { LINK: answer })).open).toBe(1);
      });

      it('leaves LINK open when no step of the flow was followed', async () => {
        const files: Files = { 'index.js': ["const https = require('https');", 'module.exports = function send(extra) {', '  https.get(extra); // FINDING', '};'] };
        const run = await recheckWith(sequence({ LINK: { score: 1.1, confidence: 1 } }, {}), await executionFor(files, 'index.js'));
        expect(missing(run.outcome, 'LINK')).toHaveLength(1);
      });
    });

    it('makes no second call for a group whose open questions no answer could settle', async () => {
      const files: Files = { 'index.js': ["const agent = require('private-agent');", 'function send(data) {', '  agent.post(url, data);', '}', 'send(1); // FINDING'] };
      const run = await recheckWith(sequence({ LINK: MISSING }, {}), await executionFor(files, 'index.js'));
      expect(run.calls).toHaveLength(1);
      expect(run.recheck).toMatchObject({ callCount: 0, questions: [], skippedUnsettleable: 1 });
      expect(missing(run.outcome, 'LINK')).toHaveLength(1);
    });

    it.each([
      ['a provider error', new ContextCheckProviderError('timeout', 'TRANSPORT'), 'TRANSPORT'],
      ['a provider timeout', new ContextCheckProviderError('deadline', 'TIMEOUT'), 'TIMEOUT'],
      ['any other error', new Error('boom'), 'INTERNAL_ERROR'],
    ])('keeps the first decision and goes on after %s', async (_name, error, reason) => {
      const { calls, recheck, outcome, added } = await recheckWith(sequence({ INPUT: MISSING }, error));
      expect(calls).toHaveLength(2);
      expect(recheck).toMatchObject({ callCount: 1, failedCallCount: 1, questions: [{ context: 'INPUT', outcome: 'RECHECK_UNAVAILABLE', failureReason: reason }] });
      expect(recheck!.questions[0]).not.toHaveProperty('second');
      expect(added).toHaveLength(3);
      expect(missing(outcome, 'INPUT')).toHaveLength(1);
      expect(outcome.record.status).toBe('EXPANDED');
      expect(summarizeContextCheck(outcome.record).recheckTimeoutCount).toBe(reason === 'TIMEOUT' ? 1 : 0);
      expect(summarizeContextCheck(outcome.record).providerTimeoutCount).toBe(reason === 'TIMEOUT' ? 1 : undefined);
    });

    it('does not ask again when every answer stands or when no code can be added', async () => {
      const visible = await recheckWith(sequence({}));
      expect(visible.calls).toHaveLength(1);
      expect(visible.recheck).toMatchObject({ callCount: 0, questions: [] });
      const tight = { ...POLICY, codeSlices: { ...POLICY.codeSlices, maxTotalCodeLines: 1 } };
      const jev = sequence({ ACTION: MISSING });
      const input = await executionFor(SINKS, 'index.js');
      const outcome = await runContextCheckWithDefaults({ enabled: true, provider: jev, execution: input, built: await build(input), rebuild: build, policy: tight.codeSlices, recheck: true });
      expect(jev.check).toHaveBeenCalledTimes(1);
      expect(outcome.record).toMatchObject({ status: 'NO_BUDGET' });
      expect(outcome.record).not.toHaveProperty('recheck');
    });

    const TWO_FILES: Files = {
      'index.js': ["require('./a');", "require('./b');"],
      'a.js': ["const https = require('https');", 'function sendA(url) {', '  https.get(url);', '}', 'let runA = sendA;', 'runA = runA;', "runA('https://a.example.test'); // FINDING"],
      'b.js': ["const https = require('https');", 'function sendB(url) {', '  https.get(url);', '}', 'let runB = sendB;', 'runB = runB;', "runB('https://b.example.test'); // SECOND"],
    };
    async function twoGroups(): Promise<Tier3ExecutionInput> {
      const input = await executionFor(TWO_FILES, 'a.js');
      const line = lineOf(TWO_FILES, 'b.js', 'SECOND');
      input.validatedPlan.targets.push({ ...input.validatedPlan.targets[0]!, targetId: 'tier3-target-002', filePath: 'b.js', preferredRange: { startLine: line, endLine: line }, findingRefs: ['F:b'] });
      input.findings.push({ ...input.findings[0]!, findingId: 'F:b', location: { file: 'b.js', startLine: line, endLine: line } });
      input.bindings.findingBindings.push({ findingId: 'F:b', artifactId: ARTIFACT, filePath: 'b.js', startLine: line, endLine: line });
      return input;
    }

    it('asks each group in a call of its own, with that group and its code only, and never a third time', async () => {
      const { calls, recheck, outcome } = await recheckWith(sequence({ ACTION: MISSING }, { ACTION: MISSING }), await twoGroups());
      expect(calls).toHaveLength(3);
      const seen = calls.slice(1).map((request) => {
        const state = request.state as { groups: Array<{ groupId: string; filePath: string }>; slices: Array<{ filePath: string; startLine: number; endLine: number }> };
        return `${state.groups.map((group) => `${group.groupId} ${group.filePath}`).join(',')} | ${state.slices.map((slice) => `${slice.filePath}:${slice.startLine}-${slice.endLine}`).join(',')} | ${Object.keys(request.questions).join(',')}`;
      }).sort();
      // Each call holds the group's file and the statement that loads it, and nothing of the other group.
      expect(seen).toEqual([
        'G1 a.js | a.js:2-3,a.js:5-5,a.js:7-7,index.js:1-1 | G1__ACTION',
        'G2 b.js | b.js:2-3,b.js:5-5,b.js:7-7,index.js:2-2 | G2__ACTION',
      ]);
      expect(recheck).toMatchObject({ callCount: 2, failedCallCount: 0 });
      expect(asked(recheck!.questions).sort()).toEqual(['ACTION UNRESOLVED unresolved', 'ACTION UNRESOLVED unresolved']);
      expect(outcome.record.unresolvedContextCount).toBe(2);
    });

    it('counts what the second check asked, changed and cost', async () => {
      const { outcome } = await recheckWith(sequence({ ACTION: MISSING }, {}), await twoGroups());
      const summary = summarizeContextCheck(outcome.record);
      expect(summary).toMatchObject({
        recheckQuestionCount: 2, recheckCallCount: 2, recheckTimeoutCount: 0, recheckResolvedRate: 1, recheckInputTokens: 200, recheckOutputTokens: 20, recheckTokensPerResolved: 110,
        recheckOutcomes: { RESOLVED: 2, UNRESOLVED: 0, IMPROVED_UNRESOLVED: 0, REGRESSED: 0, RECHECK_UNAVAILABLE: 0 },
        inputTokens: 100, outputTokens: 10,
      });
      expect(summary.recheckMsPerResolved).toBe(summary.recheckLatencyMs! / 2);
      expect(JSON.stringify(summary)).not.toMatch(/a\.js|sendA/u);
      const none = summarizeContextCheck((await recheckWith(sequence({ INPUT: MISSING }, { INPUT: MISSING }))).outcome.record);
      expect(none).toMatchObject({ recheckQuestionCount: 1, recheckResolvedRate: 0 });
      expect(none).not.toHaveProperty('recheckMsPerResolved');
      expect(none).not.toHaveProperty('recheckTokensPerResolved');
    });

    it('stops the scan when it is cancelled during the second call', async () => {
      const controller = new AbortController();
      const jev = sequence({ INPUT: MISSING }, () => { controller.abort(); throw new Error('aborted'); });
      await expect(recheckWith(jev, undefined, { signal: controller.signal })).rejects.toThrow('aborted');
    });
  });
});

describe('witness path selection', () => {
  type Range = { artifactId: string; filePath: string; startLine: number; endLine: number };
  const at = (filePath: string, startLine: number, endLine = startLine): Range => ({ artifactId: 'A', filePath, startLine, endLine });
  const pathOf = (groupId: string, statements: Range[], overrides: Partial<ContextWitnessPath> = {}): ContextWitnessPath => ({
    pathId: '', context: 'ACTION', groupId, findingId: 'F1', complete: true, steps: [], confirmedEdgeCount: 0, confirmedAsyncEdgeCount: 0, probableEdgeCount: 0,
    depth: 0, statements, newTargetCount: 0, newLineCount: 0, outcome: 'NOT_NEEDED', ...overrides,
  });
  const request = (path: ContextWitnessPath): PathRequest => ({ path, state: 'MISSING' });
  /** Applies the line and target budget in candidate order, the way candidate validation does. */
  const select = async (tiers: ContextWitnessPath[][], lines = 120, targets = 10, slices: AgentCodeSlice[] = []) => {
    const validate = async (candidates: readonly ExpansionCandidate[]) => {
      let [leftLines, leftTargets] = [lines, targets];
      const trace = candidates.map((candidate) => {
        const count = candidate.endLine - candidate.startLine + 1;
        if (leftTargets <= 0) return { selected: false, exclusionReason: 'TARGET_LIMIT' };
        if (count > leftLines) return { selected: false, exclusionReason: 'LINE_BUDGET_EXCEEDED' };
        leftTargets -= 1;
        leftLines -= count;
        return { selected: true, selectedStartLine: candidate.startLine, selectedEndLine: candidate.endLine };
      });
      return { trace } as unknown as CandidateValidationResult;
    };
    const added = await selectWitnessPaths({ tiers: tiers.map((tier) => tier.map(request)), slices, accepted: [], validate, budget: { lines, targets } });
    return added.map((candidate) => `${candidate.groupId} ${candidate.filePath}:${candidate.startLine}-${candidate.endLine}`);
  };
  const result = (path: ContextWitnessPath) => `${path.outcome}${path.exclusionReason === undefined ? '' : ` ${path.exclusionReason}`}`;

  it('adds a path whole or not at all: no statement of a path that does not fit is added', async () => {
    const fits = pathOf('G1', [at('a.js', 1, 20)]);
    const tooLong = pathOf('G1', [at('b.js', 1, 50), at('c.js', 1, 60)], { findingId: 'F2' });
    expect(await select([[tooLong, fits]])).toEqual(['G1 a.js:1-20']);
    expect(tooLong).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET', exclusionReason: 'LINE_BUDGET', newLineCount: 0, newTargetCount: 0 });
    expect(fits).toMatchObject({ outcome: 'ADDED', newLineCount: 20, newTargetCount: 1, selectionOrder: 1 });
  });

  it('adds the operation a path ends at when no step leads there and no slice holds it', async () => {
    const supplied = [{ artifactId: 'A', filePath: 'a.js', startLine: 2, endLine: 2 }] as AgentCodeSlice[];
    // A Finding of the group outside the slices: its path has no statement, only the call it ends at.
    const outside = pathOf('G1', [], { sink: { ...at('a.js', 9), callee: 'https.get' } });
    const inside = pathOf('G2', [], { sink: { ...at('a.js', 2), callee: 'https.get' } });
    expect(await select([[outside, inside]], 120, 10, supplied)).toEqual(['G1 a.js:9-9']);
    expect(outside).toMatchObject({ outcome: 'ADDED', newLineCount: 1, newTargetCount: 1 });
    expect(result(inside)).toBe('ALREADY_IN_SLICES ALREADY_IN_SLICES');
    // The call is not asked for twice when the path lists it as a statement as well.
    const listed = pathOf('G3', [at('b.js', 4)], { sink: { ...at('b.js', 4), callee: 'https.get' } });
    expect(await select([[listed]], 120, 10, supplied)).toEqual(['G3 b.js:4-4']);
    expect(listed).toMatchObject({ outcome: 'ADDED', newLineCount: 1, newTargetCount: 1 });
  });

  it('adds nothing of a path that needs more targets than are left', async () => {
    const wide = pathOf('G1', [at('a.js', 1), at('b.js', 1), at('c.js', 1)]);
    expect(await select([[wide]], 120, 2)).toEqual([]);
    expect(wide).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'TARGET_BUDGET' });
  });

  it('adds a partially supplied listener statement whole or records a budget failure', async () => {
    const supplied = [{ artifactId: 'A', filePath: 'listener.js', startLine: 3, endLine: 6 }] as AgentCodeSlice[];
    const fits = pathOf('G1', [at('listener.js', 1, 7)]);
    expect(await select([[fits]], 7, 10, supplied)).toEqual(['G1 listener.js:1-7']);
    const doesNotFit = pathOf('G1', [at('listener.js', 1, 7)]);
    expect(await select([[doesNotFit]], 3, 10, supplied)).toEqual([]);
    expect(doesNotFit).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET', exclusionReason: 'LINE_BUDGET' });
  });

  it('selects a CompositeWitness only when every stage and link statement fits atomically', async () => {
    const composite = pathOf('G1', [at('collect.js', 1, 10), at('send.js', 1, 10)], {
      composite: {
        behavior: 'COLLECT_AND_SEND', status: 'COMPLETE', requiredStages: ['COLLECT', 'SEND'], confirmedStages: ['COLLECT', 'SEND'],
        missingStages: [], missingConnections: [], stageWitnesses: [], connectionWitnesses: [], complete: true,
      },
    });
    expect(await select([[composite]], 20, 1)).toEqual([]);
    expect(composite).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'TARGET_BUDGET', composite: { status: 'COMPLETE' } });
  });

  it('drops a path with the statements of a better path of the same context, not one that only ends at the same sink', async () => {
    const best = pathOf('G1', [at('a.js', 1), at('b.js', 5)], { sink: at('b.js', 5) });
    const sameStatements = pathOf('G1', [at('b.js', 5), at('a.js', 1)], { findingId: 'F2', depth: 1, confirmedEdgeCount: 1 });
    const sameSink = pathOf('G1', [at('c.js', 9), at('b.js', 5)], { findingId: 'F3', depth: 2, confirmedEdgeCount: 2, sink: at('b.js', 5) });
    const otherContext = pathOf('G1', [at('a.js', 1), at('b.js', 5)], { context: 'LINK', sink: at('b.js', 5) });
    expect(await select([[best, sameStatements, sameSink, otherContext]])).toEqual(['G1 a.js:1-1', 'G1 b.js:5-5', 'G1 c.js:9-9']);
    expect([best, sameStatements, sameSink, otherContext].map(result)).toEqual(['ADDED', 'NOT_ADDED DUPLICATE_PATH', 'ADDED', 'ALREADY_IN_SLICES ALREADY_IN_SLICES']);
  });

  it('keeps distinct composite sources that converge on the same final sink', async () => {
    const composite = () => ({
      behavior: 'COLLECT_AND_SEND' as const, status: 'COMPLETE' as const, requiredStages: ['COLLECT', 'SEND'], confirmedStages: ['COLLECT', 'SEND'],
      missingStages: [], missingConnections: [], stageWitnesses: [], connectionWitnesses: [], complete: true,
    });
    const first = pathOf('G1', [at('a.js', 1), at('send.js', 5)], { sink: at('send.js', 5), composite: composite() });
    const second = pathOf('G1', [at('b.js', 1), at('send.js', 5)], { findingId: 'F2', sink: at('send.js', 5), composite: composite() });
    expect(await select([[first, second]])).toEqual(['G1 a.js:1-1', 'G1 send.js:5-5', 'G1 b.js:1-1']);
    expect([first.outcome, second.outcome]).toEqual(['ADDED', 'ADDED']);
  });

  it('ranks confirmed paths first, then the ones with fewer probable steps, and leaves incomplete ones out', async () => {
    const twoProbable = pathOf('G1', [at('a.js', 1, 40)], { depth: 3, confirmedEdgeCount: 1, probableEdgeCount: 2, complete: false, failureReason: 'PROBABLE_EDGE_LIMIT' });
    const oneProbable = pathOf('G1', [at('b.js', 1, 10)], { depth: 2, confirmedEdgeCount: 1, probableEdgeCount: 1 });
    const confirmed = pathOf('G1', [at('c.js', 1, 50)], { depth: 4, confirmedEdgeCount: 4 });
    expect(await select([[twoProbable, oneProbable, confirmed]], 55)).toEqual(['G1 c.js:1-50']);
    expect([confirmed.rank, oneProbable.rank, twoProbable.rank]).toEqual([1, 2, undefined]);
    expect([confirmed, oneProbable, twoProbable].map(result)).toEqual(['ADDED', 'NOT_ADDED LINE_BUDGET', 'NOT_ADDED PROBABLE_EDGE_LIMIT']);
  });

  it('adds an alternative only for lines the selected paths do not hold', async () => {
    const first = pathOf('G1', [at('a.js', 1, 10), at('b.js', 1, 5)]);
    const inside = pathOf('G1', [at('a.js', 2, 6)], { depth: 1, probableEdgeCount: 1 });
    const other = pathOf('G1', [at('a.js', 1, 10), at('c.js', 1, 5)], { depth: 2, confirmedEdgeCount: 2 });
    expect(await select([[first, inside, other]])).toEqual(['G1 a.js:1-10', 'G1 b.js:1-5', 'G1 c.js:1-5']);
    expect([first, inside, other].map(result)).toEqual(['ADDED', 'NOT_ADDED DUPLICATE_EVIDENCE', 'ADDED']);
    expect(other).toMatchObject({ newLineCount: 5, newTargetCount: 1, selectionOrder: 2 });
  });

  it('treats the next path of a Finding whose first path was added earlier as an alternative', async () => {
    const first = pathOf('G1', [at('a.js', 1, 10)], { outcome: 'ADDED' });
    const inside = pathOf('G1', [at('a.js', 2, 6)], { depth: 1, confirmedEdgeCount: 1 });
    const validate = async () => ({ trace: [] }) as unknown as CandidateValidationResult;
    const accepted = [{ groupId: 'G1', context: 'ACTION', state: 'MISSING', kind: 'WITNESS_PATH', depth: 1, artifactId: 'A', filePath: 'a.js', startLine: 1, endLine: 10, units: [{ startLine: 1, endLine: 10, executable: true }], statementAligned: true }] as ExpansionCandidate[];
    await selectWitnessPaths({ tiers: [[request(first), request(inside)]], slices: [], accepted, validate, budget: { lines: 120, targets: 10 } });
    expect(result(first)).toBe('ADDED');
    expect(result(inside)).toBe('NOT_ADDED DUPLICATE_EVIDENCE');
  });

  it('gives every Finding its best path before any alternative', async () => {
    const a1 = pathOf('G1', [at('a.js', 1, 30)]);
    const a2 = pathOf('G1', [at('b.js', 1, 30)], { depth: 1, confirmedEdgeCount: 1 });
    const b1 = pathOf('G1', [at('c.js', 1, 30)], { findingId: 'F2', depth: 3, confirmedEdgeCount: 2, probableEdgeCount: 1 });
    expect(await select([[a1, a2, b1]], 60)).toEqual(['G1 a.js:1-30', 'G1 c.js:1-30']);
    expect([a1.rank, b1.rank, a2.rank]).toEqual([1, 2, 3]);
    expect(result(a2)).toBe('NOT_ADDED LINE_BUDGET');
  });

  it('gives every group its first path before a large one takes the budget', async () => {
    const large = pathOf('G1', [at('a.js', 1, 100)]);
    const small = pathOf('G2', [at('b.js', 1, 30)]);
    expect(await select([[large, small]])).toEqual(['G2 b.js:1-30']);
    expect(large).toMatchObject({ outcome: 'NOT_ADDED', failureReason: 'LINE_BUDGET', exclusionReason: 'LINE_BUDGET' });
    expect(small).toMatchObject({ outcome: 'ADDED', selectionOrder: 1 });
  });

  it('adds the large path after the small ones when it still fits', async () => {
    const large = pathOf('G1', [at('a.js', 1, 80)]);
    const small = pathOf('G2', [at('b.js', 1, 30)]);
    expect(await select([[large, small]])).toEqual(['G2 b.js:1-30', 'G1 a.js:1-80']);
    expect([small.selectionOrder, large.selectionOrder]).toEqual([1, 2]);
    expect(large.exclusionReason).toBeUndefined();
  });

  it('serves every group once before the alternatives of a group with many paths', async () => {
    const many = [1, 2, 3, 4].map((n) => pathOf('G1', [at(`a${n}.js`, 1, 25)], { depth: n, confirmedEdgeCount: n }));
    const single = pathOf('G2', [at('b.js', 1, 25)]);
    expect(await select([[...many, single]], 100)).toEqual(['G1 a1.js:1-25', 'G2 b.js:1-25', 'G1 a2.js:1-25', 'G1 a3.js:1-25']);
    expect(result(many[3]!)).toBe('NOT_ADDED LINE_BUDGET');
  });

  it('does not hold a path back when it is the only one asking', async () => {
    const large = pathOf('G1', [at('a.js', 1, 100)]);
    expect(await select([[large]])).toEqual(['G1 a.js:1-100']);
  });

  it('takes the units of an earlier tier first', async () => {
    const partial = pathOf('G1', [at('a.js', 1, 10)]);
    const missing = pathOf('G2', [at('b.js', 1, 10)]);
    expect(await select([[missing], [partial]])).toEqual(['G2 b.js:1-10', 'G1 a.js:1-10']);
  });
});

describe('validated pre-check witness projection', () => {
  const candidate = (groupId: string, startLine: number, endLine: number): ExpansionCandidate => ({
    groupId, context: 'TRIGGER', state: 'PARTIAL', kind: 'EXECUTION_PATH', depth: 1, artifactId: ORIGINAL, filePath: 'index.js',
    startLine, endLine, units: endLine - startLine >= 3
      ? [{ startLine, endLine: startLine + 1 }, { startLine: startLine + 2, endLine }]
      : [{ startLine, endLine }], statementAligned: true,
  });

  it('keeps only exact selected or credited target ranges and drops rejected or unselected units', () => {
    const offered = [candidate('G1', 1, 4), candidate('G2', 1, 2), candidate('G3', 8, 9)];
    const projected = acceptedCandidateRanges(offered, {
      targets: [{ targetId: 'context-target-001', artifactId: ORIGINAL, filePath: 'index.js', preferredRange: { startLine: 1, endLine: 2 } }],
      outcomes: [
        { targetId: 'context-target-001', creditedTargetIds: [], alreadySupplied: false },
        { targetId: null, creditedTargetIds: ['context-target-001'], alreadySupplied: false },
        { targetId: null, creditedTargetIds: [], alreadySupplied: false },
      ],
    });
    expect(projected.map(({ candidate: item, targetId }) => `${item.groupId} ${item.startLine}-${item.endLine} ${item.units.map((unit) => `${unit.startLine}-${unit.endLine}`).join(',')} ${targetId}`))
      .toEqual(['G1 1-2 1-2 context-target-001', 'G2 1-2 1-2 context-target-001']);
  });
});

describe('second check targets', () => {
  const state = (context: ContextCode, value: 'VISIBLE' | 'PARTIAL' | 'MISSING', groupId = 'G1') => (
    { groupId, filePath: 'a.js', behavior: 'NETWORK_SEND' as const, context, state: value, score: value === 'VISIBLE' ? 2 : value === 'PARTIAL' ? 1 : 0, confidence: 1 }
  );
  const targets = (states: ReturnType<typeof state>[], served: string[], inputTouchesTarget = false) => (
    [...recheckTargets({ states, served: new Set(served), inputTouchesTarget: () => inputTouchesTarget })]
      .flatMap(([groupId, items]) => items.map((item) => `${groupId} ${item.context} ${item.reason}`))
  );
  const ALL = CONTEXT_CODES.map((context) => state(context, 'PARTIAL'));

  it('asks about a context code was added for and never about a VISIBLE one', () => {
    expect(targets([state('ACTION', 'MISSING'), state('LINK', 'VISIBLE'), state('TRIGGER', 'PARTIAL')], ['G1__ACTION', 'G1__LINK'])).toEqual(['G1 ACTION CODE_ADDED']);
    expect(targets(ALL, [])).toEqual([]);
  });

  it.each([
    ['INPUT', ['INPUT CODE_ADDED', 'LINK RELATED_CONTEXT_ADDED']],
    ['ACTION', ['ACTION CODE_ADDED', 'LINK RELATED_CONTEXT_ADDED']],
    ['TARGET', ['TARGET CODE_ADDED', 'LINK RELATED_CONTEXT_ADDED']],
    ['TRIGGER', ['TRIGGER CODE_ADDED']],
    ['LINK', ['LINK CODE_ADDED']],
  ] as const)('asks about the contexts code added for %s bears on', (context, expected) => {
    expect(targets(ALL, [`G1__${context}`]).map((item) => item.replace('G1 ', '')).sort()).toEqual([...expected].sort());
  });

  it('asks about TARGET after INPUT code only when that code lies on a TARGET path', () => {
    expect(targets(ALL, ['G1__INPUT'], true).map((item) => item.replace('G1 ', '')).sort()).toEqual(['INPUT CODE_ADDED', 'LINK RELATED_CONTEXT_ADDED', 'TARGET RELATED_CONTEXT_ADDED']);
  });

  it('leaves out a question the second answer cannot settle', () => {
    const none = [...recheckTargets({ states: [state('TRIGGER', 'MISSING')], served: new Set(['G1__TRIGGER']), inputTouchesTarget: () => false, excluded: new Set(['G1__TRIGGER']) })];
    expect(none).toEqual([]);
  });

  it('asks groups in the same artifact file together while keeping their questions and answers independent', async () => {
    const groups = [
      { groupId: 'G1', artifactId: 'A', filePath: 'same.js', behavior: 'NETWORK_SEND', findingIds: ['F1'], contexts: ['ACTION'], priority: 1 },
      { groupId: 'G2', artifactId: 'A', filePath: 'same.js', behavior: 'PROCESS_EXEC', findingIds: ['F2'], contexts: ['ACTION'], priority: 1 },
    ] as unknown as FindingGroup[];
    const slices = new Map([
      ['G1', [{ artifactId: 'A', sliceId: 'SHARED' }, { artifactId: 'A', sliceId: 'ONLY-G1' }]],
      ['G2', [{ artifactId: 'A', sliceId: 'SHARED' }, { artifactId: 'A', sliceId: 'ONLY-G2' }]],
    ]) as unknown as Map<string, AgentCodeSlice[]>;
    const requests: ContextCheckRequest[] = [];
    const provider = { check: jest.fn(async (request: ContextCheckRequest) => {
      requests.push(request);
      return { model: 'jev-test', answers: { G1__ACTION: VISIBLE, G2__ACTION: { score: 1, confidence: 1 } }, usage: { inputTokens: 50, outputTokens: 5 } };
    }) };
    const record = await runRecheck({
      provider, groups, states: [state('ACTION', 'MISSING', 'G1'), state('ACTION', 'MISSING', 'G2')],
      served: new Set(['G1__ACTION', 'G2__ACTION']), inputTouchesTarget: () => false,
      slicesOf: (group) => slices.get(group.groupId)!,
      request: (asked, given) => ({
        state: { groups: asked.map((group) => group.groupId), ids: given.map((slice) => slice.sliceId) },
        questions: Object.fromEntries(asked.map((group) => [questionKey(group.groupId, 'ACTION'), { type: 'score', instructions: group.groupId, criteria: [] }])),
      }),
    });
    expect(provider.check).toHaveBeenCalledTimes(1);
    expect(requests[0]!.state).toEqual({ groups: ['G1', 'G2'], ids: ['SHARED', 'ONLY-G1', 'ONLY-G2'] });
    expect(Object.keys(requests[0]!.questions)).toEqual(['G1__ACTION', 'G2__ACTION']);
    expect(record).toMatchObject({
      callCount: 1, failedCallCount: 0, usage: { inputTokens: 50, outputTokens: 5 },
      questions: [
        { groupId: 'G1', context: 'ACTION', outcome: 'RESOLVED' },
        { groupId: 'G2', context: 'ACTION', outcome: 'IMPROVED_UNRESOLVED' },
      ],
    });
  });

  it('keeps equal paths in different artifacts in separate recheck calls', async () => {
    const groups = [
      { groupId: 'G1', artifactId: 'A', filePath: 'same.js', behavior: 'NETWORK_SEND', findingIds: ['F1'], contexts: ['ACTION'], priority: 1 },
      { groupId: 'G2', artifactId: 'B', filePath: 'same.js', behavior: 'NETWORK_SEND', findingIds: ['F2'], contexts: ['ACTION'], priority: 1 },
    ] as unknown as FindingGroup[];
    const provider = { check: jest.fn(async (request: ContextCheckRequest) => ({
      model: 'jev-test', answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, VISIBLE])), usage: {},
    })) };
    const record = await runRecheck({
      provider, groups, states: [state('ACTION', 'MISSING', 'G1'), state('ACTION', 'MISSING', 'G2')],
      served: new Set(['G1__ACTION', 'G2__ACTION']), inputTouchesTarget: () => false,
      slicesOf: (group) => [{ artifactId: group.artifactId, sliceId: group.groupId }] as unknown as AgentCodeSlice[],
      request: (asked) => ({ state: {}, questions: Object.fromEntries(asked.map((group) => [questionKey(group.groupId, 'ACTION'), { type: 'score', instructions: 'q', criteria: [] }])) }),
    });
    expect(provider.check).toHaveBeenCalledTimes(2);
    expect(record.callCount).toBe(2);
  });

  it('falls back to valid per-group requests when a same-file batch exceeds the input limit', async () => {
    const groups = [
      { groupId: 'G1', artifactId: 'A', filePath: 'same.js', behavior: 'NETWORK_SEND', findingIds: ['F1'], contexts: ['ACTION'], priority: 1 },
      { groupId: 'G2', artifactId: 'A', filePath: 'same.js', behavior: 'PROCESS_EXEC', findingIds: ['F2'], contexts: ['ACTION'], priority: 1 },
    ] as unknown as FindingGroup[];
    const sent: string[][] = [];
    const provider = { check: jest.fn(async (request: ContextCheckRequest) => {
      sent.push(Object.keys(request.questions));
      return { model: 'jev-test', answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, VISIBLE])), usage: {} };
    }) };
    const record = await runRecheck({
      provider, groups, states: [state('ACTION', 'MISSING', 'G1'), state('ACTION', 'MISSING', 'G2')],
      served: new Set(['G1__ACTION', 'G2__ACTION']), inputTouchesTarget: () => false,
      slicesOf: (group) => [{ artifactId: group.artifactId, sliceId: group.groupId }] as unknown as AgentCodeSlice[],
      request: (asked) => ({
        state: { pad: 'x'.repeat(asked.length * 50_000) },
        questions: Object.fromEntries(asked.map((group) => [questionKey(group.groupId, 'ACTION'), { type: 'score', instructions: 'q', criteria: [] }])),
      }),
    });
    expect(sent).toEqual([['G1__ACTION'], ['G2__ACTION']]);
    expect(record).toMatchObject({ callCount: 2, failedCallCount: 0, questions: [{ outcome: 'RESOLVED' }, { outcome: 'RESOLVED' }] });
  });

  describe('a second request that is too large', () => {
    const group = { groupId: 'G1', artifactId: 'A', filePath: 'a.js', behavior: 'NETWORK_SEND', findingIds: ['F1'], contexts: ['ACTION'], priority: 1 } as unknown as FindingGroup;
    const slices = Array.from({ length: 10 }, (_, index) => ({ sliceId: `S${index}` })) as unknown as AgentCodeSlice[];
    const recheck = async (charsPerSlice: number) => {
      const sent: string[][] = [];
      const jev = { check: jest.fn(async (request: ContextCheckRequest) => {
        sent.push((request.state as { ids: string[] }).ids);
        return { model: 'jev-test', answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, VISIBLE])), usage: { inputTokens: 1, outputTokens: 1 } };
      }) };
      const record = await runRecheck({
        provider: jev, groups: [group], states: [state('ACTION', 'MISSING')], served: new Set(['G1__ACTION']), inputTouchesTarget: () => false,
        slicesOf: () => slices,
        request: ([asked], given) => ({ state: { ids: given.map((slice) => slice.sliceId), pad: 'x'.repeat(given.length * charsPerSlice) }, questions: { [`${asked!.groupId}__ACTION`]: { type: 'score', instructions: 'q', criteria: ['a', 'b', 'c'] } } }),
      });
      return { record, sent };
    };

    it('leaves out the least needed slices until it fits, and still asks', async () => {
      const { record, sent } = await recheck(20_000);
      // The slices come most needed first, so the ones kept are the first ones.
      expect(sent).toEqual([['S0', 'S1', 'S2', 'S3']]);
      expect(record).toMatchObject({ callCount: 1, trimmedSliceCount: 6, questions: [{ context: 'ACTION', outcome: 'RESOLVED' }] });
      expect((await recheck(1_000)).record).not.toHaveProperty('trimmedSliceCount');
    });

    it('gives up only when one slice alone is too large', async () => {
      const { record, sent } = await recheck(CONTEXT_CHECK_LIMITS.maxStateChars + 1);
      expect(sent).toEqual([]);
      expect(record).toMatchObject({ callCount: 0, questions: [{ outcome: 'RECHECK_UNAVAILABLE', failureReason: 'INPUT_TOO_LARGE' }] });
    });
  });

  it('keeps groups apart', () => {
    expect(targets([state('LINK', 'PARTIAL', 'G1'), state('LINK', 'PARTIAL', 'G2'), state('ACTION', 'MISSING', 'G2')], ['G2__ACTION'])).toEqual(['G2 LINK RELATED_CONTEXT_ADDED', 'G2 ACTION CODE_ADDED']);
  });
});
