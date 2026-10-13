import type { StaticFilterReasonCode, StaticFilterRuleId } from '../../application/planning/static-filter.types';
import {
  CONTEXT_CODES,
  UNASKED_BEHAVIOR_GROUPS,
  type AskedBehaviorGroup,
  type BehaviorGroup,
  type ContextCode,
  type GroupPriority,
  type RestorationStatus,
} from './context-check.contract';

/**
 * Rule IDs whose behavior group follows from the rule alone. GuardDog rules are
 * the v3.1.0 rules that can match a JS/TS file or package.json; rules that only
 * match Python files are left out and fall to OTHER if they ever appear.
 */
export const RULES_BY_BEHAVIOR: Record<BehaviorGroup, readonly string[]> = {
  NETWORK_SEND: [
    'capability-network-outbound', 'threat-network-exfiltration', 'threat-network-outbound-shady-links',
    'threat-network-exfil-messenger', 'threat-network-dns-exfil', 'custom.network-outbound',
  ],
  COLLECT_AND_SEND: [
    'threat-network-exfil-sysinfo', 'threat-npm-dependency-confusion', 'threat-network-form-data-exfiltration',
    'custom.env-network-coexistence', 'custom.sensitive-file-network-coexistence',
  ],
  SENSITIVE_READ: [
    'capability-filesystem-browser', 'capability-filesystem-read', 'threat-filesystem-read',
    'threat-runtime-environment-read', 'custom.sensitive-file-access', 'custom.credential-source',
  ],
  // Plain configuration variables; `custom.collection-source` Findings are routed here by what they matched.
  ENVIRONMENT_READ: [],
  DOWNLOAD: ['capability-network-download', 'custom.remote-download'],
  DOWNLOAD_AND_EXECUTE: ['threat-process-download-exec'],
  REMOTE_SHELL: ['threat-network-reverse-shell'],
  PROCESS_EXEC: [
    'capability-network-lolbas', 'threat-process-powershell-encoded', 'threat-process-spawn-silent',
    'threat-process-injection-dll', 'custom.process-execution',
  ],
  FILE_MUTATION: [
    'capability-filesystem-delete', 'capability-filesystem-write-executable', 'threat-filesystem-destruction',
    'custom.filesystem.write',
  ],
  LIFECYCLE: [
    'capability-process-hooks', 'threat-process-hooks', 'threat-npm-preinstall-script', 'custom.lifecycle-entry',
    'custom.lifecycle-process-coexistence',
  ],
  PERSISTENCE: ['capability-process-schedule', 'threat-filesystem-autostart'],
  SURVEILLANCE: ['capability-runtime-clipboard', 'threat-runtime-keylogging', 'threat-process-memory'],
  SYSTEM_DISCOVERY: ['threat-process-sysinfo', 'threat-runtime-system-info', 'threat-runtime-enumeration'],
  PROPAGATION: ['threat-runtime-self-propagation'],
  DYNAMIC_CODE: [
    'threat-runtime-obfuscation-api', 'threat-runtime-obfuscation-base64exec', 'threat-runtime-obfuscation-dynamic-eval',
    'threat-runtime-obfuscation-steganography', 'threat-runtime-obfuscation-hidden-code',
  ],
  OTHER: ['threat-process-cryptomining'],
  OBFUSCATION_SIGNAL: [
    'threat-runtime-obfuscation', 'threat-runtime-obfuscation-general', 'threat-runtime-obfuscation-js-mangling',
    'threat-runtime-obfuscation-unicode', 'threat-runtime-obfuscation-log-suppress',
  ],
  PACKAGE_RISK: ['threat-npm-http-dependency', 'metadata.license.mismatch', 'metadata.repository.mismatch'],
};

export const METADATA_LIFECYCLE_PREFIX = 'metadata.lifecycle.';
export const RESTORATION_STATUS_PREFIX = 'obfuscation.';

/** Rules whose behavior group depends on what the Finding matched. */
export const MATCH_CLASSIFIED_RULES = ['custom.collection-source', 'capability-process-spawn'] as const;

const BEHAVIOR_BY_RULE = new Map<string, BehaviorGroup>(
  (Object.entries(RULES_BY_BEHAVIOR) as Array<[BehaviorGroup, readonly string[]]>)
    .flatMap(([behavior, rules]) => rules.map((rule) => [rule, behavior] as const)),
);

const SYSTEM_INFORMATION_API = /\b(?:hostname|platform|arch|type|release|userInfo)\s*\(|\bprocess\.cwd\s*\(/u;
const PROCESS_ENV = /\bprocess\.env\b/u;
const USER_INPUT_READ = /\b(?:readText|read)\s*\(|\.on\s*\(\s*['"](?:keydown|keypress|keyboard)['"]/u;
/** What `custom.collection-source` says it matched (`data.sourceType`), by behavior group. */
const BEHAVIOR_BY_SOURCE_TYPE: Record<string, BehaviorGroup> = {
  ENVIRONMENT_VARIABLE: 'ENVIRONMENT_READ', CREDENTIAL_ENVIRONMENT: 'SENSITIVE_READ', SYSTEM_INFORMATION: 'SYSTEM_DISCOVERY', USER_INPUT: 'SURVEILLANCE',
};
const FORM_SERIALIZATION = /\.serialize(?:Array)?\s*\(|\bnew\s+FormData\s*\(/u;
const CHILD_PROCESS_CALL = /child_process|\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\b/u;
const DYNAMIC_CODE_CALL = /\beval\s*\(|\bnew\s+Function\s*\(/u;

function behaviorByMatch(ruleId: string, matchText: string | undefined, sourceType?: string): BehaviorGroup {
  if (ruleId === 'custom.collection-source' && sourceType !== undefined && BEHAVIOR_BY_SOURCE_TYPE[sourceType] !== undefined) return BEHAVIOR_BY_SOURCE_TYPE[sourceType];
  if (matchText === undefined || matchText.trim() === '') return 'OTHER';
  if (ruleId === 'custom.collection-source') {
    // Without the rule's own label the line is read in the order the rule reads it.
    if (FORM_SERIALIZATION.test(matchText)) return 'OTHER';
    if (PROCESS_ENV.test(matchText)) return 'ENVIRONMENT_READ';
    if (SYSTEM_INFORMATION_API.test(matchText)) return 'SYSTEM_DISCOVERY';
    return USER_INPUT_READ.test(matchText) ? 'SURVEILLANCE' : 'OTHER';
  }
  if (CHILD_PROCESS_CALL.test(matchText)) return 'PROCESS_EXEC';
  return DYNAMIC_CODE_CALL.test(matchText) ? 'DYNAMIC_CODE' : 'OTHER';
}

const USER_INPUT_API = /clipboard|\breadText\s*\(|\.on\s*\(\s*['"](?:keydown|keypress|keyboard)['"]/iu;

/**
 * A `custom.collection-source` Finding grouped as SURVEILLANCE whose own line shows no clipboard or key-event API:
 * the rule also matches any `.read(` call. Unknown line text is not taken as unsupported.
 */
export function isUnsupportedUserInputMatch(ruleId: string, behavior: BehaviorGroup, matchText: string | null | undefined): boolean {
  return ruleId === 'custom.collection-source' && behavior === 'SURVEILLANCE' && typeof matchText === 'string' && matchText.trim() !== '' && !USER_INPUT_API.test(matchText);
}

/**
 * Behavior group of a Finding. `matchText` is the Finding's `rawMatch` or, when
 * it has none, the single source line at the Finding's exact start line; it is
 * only read for the match-classified rules and an absent text means OTHER.
 * Restoration-status rules are not behaviors; route them with
 * `restorationStatusForRule` before calling this.
 */
export function behaviorGroupForRule(ruleId: string, matchText?: string | null, sourceType?: string): BehaviorGroup {
  if (ruleId.startsWith(METADATA_LIFECYCLE_PREFIX)) return 'LIFECYCLE';
  if ((MATCH_CLASSIFIED_RULES as readonly string[]).includes(ruleId)) return behaviorByMatch(ruleId, matchText ?? undefined, sourceType);
  return BEHAVIOR_BY_RULE.get(ruleId) ?? 'OTHER';
}

/** Restoration status a Tier 2 `obfuscation.*` rule stands for, or undefined for any other rule. */
export function restorationStatusForRule(ruleId: string): RestorationStatus | undefined {
  if (!ruleId.startsWith(RESTORATION_STATUS_PREFIX)) return undefined;
  if (ruleId === 'obfuscation.restored') return 'RESTORED';
  if (ruleId === 'obfuscation.unresolved') return 'UNRESOLVED';
  if (ruleId === 'obfuscation.not-selected') return 'NOT_SELECTED';
  if (ruleId.startsWith('obfuscation.technique.')) return 'TECHNIQUE';
  // `obfuscation.detected` and any status added later: known to be about obfuscation, never a behavior.
  return 'DETECTED';
}

export function isAskedBehavior(behavior: BehaviorGroup): behavior is AskedBehaviorGroup {
  return !(UNASKED_BEHAVIOR_GROUPS as readonly BehaviorGroup[]).includes(behavior);
}

const COMPOSITE_BEHAVIORS: readonly BehaviorGroup[] = ['COLLECT_AND_SEND', 'DOWNLOAD_AND_EXECUTE', 'REMOTE_SHELL'];
const INSTALL_OR_SPREAD_BEHAVIORS: readonly BehaviorGroup[] = ['LIFECYCLE', 'PERSISTENCE', 'PROPAGATION'];

/** Selection rank of a group when more groups exist than can be asked; 1 is asked first. */
export function groupPriority(behavior: BehaviorGroup, ruleIds: readonly string[]): GroupPriority {
  if (COMPOSITE_BEHAVIORS.includes(behavior)) return 1;
  if (ruleIds.some((ruleId) => ruleId.startsWith('threat-'))) return 2;
  if (INSTALL_OR_SPREAD_BEHAVIORS.includes(behavior)) return 3;
  if (ruleIds.some((ruleId) => ruleId.startsWith('capability-'))) return 4;
  return 5;
}

const WITHOUT_INPUT: readonly ContextCode[] = ['TRIGGER', 'ACTION', 'TARGET', 'LINK'];

/**
 * Contexts asked for a behavior group when nothing else is known. Groups that
 * leave INPUT out read their input from the same code as TARGET (a path, URL or
 * key) or from the device or system itself. LIFECYCLE also leaves TARGET out
 * because the lifecycle command names what runs. OBFUSCATION_SIGNAL and
 * PACKAGE_RISK ask nothing: more code does not explain an obfuscation marker or
 * a package-level indicator.
 */
export const BASE_CONTEXTS: Record<BehaviorGroup, readonly ContextCode[]> = {
  NETWORK_SEND: CONTEXT_CODES,
  COLLECT_AND_SEND: CONTEXT_CODES,
  SENSITIVE_READ: WITHOUT_INPUT,
  // The read is its own operation and names its own variable: what is open is when it runs and where the value goes.
  ENVIRONMENT_READ: ['TRIGGER', 'LINK'],
  DOWNLOAD: WITHOUT_INPUT,
  DOWNLOAD_AND_EXECUTE: CONTEXT_CODES,
  REMOTE_SHELL: WITHOUT_INPUT,
  PROCESS_EXEC: CONTEXT_CODES,
  FILE_MUTATION: CONTEXT_CODES,
  LIFECYCLE: ['TRIGGER', 'ACTION', 'LINK'],
  PERSISTENCE: WITHOUT_INPUT,
  SURVEILLANCE: WITHOUT_INPUT,
  SYSTEM_DISCOVERY: WITHOUT_INPUT,
  PROPAGATION: CONTEXT_CODES,
  DYNAMIC_CODE: CONTEXT_CODES,
  OTHER: CONTEXT_CODES,
  OBFUSCATION_SIGNAL: [],
  PACKAGE_RISK: [],
};

/**
 * Contexts a static-filter reason asks for on top of the base contexts. Only
 * reasons that more code can settle are listed; every other reason leaves the
 * contexts as they are and is preserved instead (see `PRESERVED_REASONS`).
 */
export const REASON_CONTEXTS: Partial<Record<StaticFilterReasonCode, readonly ContextCode[]>> = {
  BEHAVIOR_LINK_UNVERIFIED: ['INPUT', 'LINK'],
  PAYLOAD_CONTENT_UNVERIFIED: ['TARGET', 'LINK'],
  LIFECYCLE_LINK_UNVERIFIED: ['TRIGGER', 'LINK'],
  PROPAGATION_LINK_UNVERIFIED: ['TARGET', 'LINK'],
  RELATION_CANDIDATE_UNVERIFIED: ['LINK'],
  EVIDENCE_CONTEXT_MISSING: ['ACTION', 'TARGET'],
};

/**
 * Reason a static-filter rule stands for, as `reasonsFor` in
 * `application/planning/static-filter.ts` derives it. A diagnostic carries the
 * rule ID and its Findings but not the reason code, so this is how a reason is
 * tied to the Findings it came from. Rules whose diagnostics never reference a
 * Finding (I03, I08) or never apply (A10, I07, I09) are not listed.
 */
export const REASON_BY_RULE: Partial<Record<StaticFilterRuleId, StaticFilterReasonCode>> = {
  A01: 'OBFUSCATION_UNRESOLVED',
  A02: 'BEHAVIOR_LINK_UNVERIFIED',
  A03: 'BEHAVIOR_LINK_UNVERIFIED',
  A04: 'PAYLOAD_CONTENT_UNVERIFIED',
  A05: 'LIFECYCLE_LINK_UNVERIFIED',
  A06: 'BEHAVIOR_LINK_UNVERIFIED',
  A07: 'DUAL_USE_CONTEXT_UNRESOLVED',
  A08: 'PROPAGATION_LINK_UNVERIFIED',
  A09: 'RELATION_CANDIDATE_UNVERIFIED',
  I01: 'ANALYZER_INCOMPLETE',
  I02: 'EVIDENCE_CONTEXT_MISSING',
  I04: 'RESTORATION_INCOMPLETE',
  I05: 'RESTORATION_BUDGET_EXCEEDED',
  I06: 'PROVENANCE_INCOMPLETE',
};

/**
 * Reasons that add no context: more code cannot settle them (unresolved
 * obfuscation, analyzer, restoration, provenance), or every context they need is
 * already a base context of the groups they apply to (dual use). They are handed
 * to Tier 3 and kept in the record so they are not lost.
 */
export const PRESERVED_REASONS: readonly StaticFilterReasonCode[] = [
  'OBFUSCATION_UNRESOLVED', 'DUAL_USE_CONTEXT_UNRESOLVED', 'ANALYZER_INCOMPLETE', 'RESTORATION_INCOMPLETE',
  'RESTORATION_BUDGET_EXCEEDED', 'PROVENANCE_INCOMPLETE',
];

/**
 * Base contexts of the behavior group plus whatever the given static-filter
 * reasons require, in context order. `reasonCodes` are the reasons tied to the
 * group's own Findings; without any this is the base set. A group that is never
 * asked stays empty whatever its reasons are.
 */
export function resolveActiveContexts(behavior: BehaviorGroup, reasonCodes: readonly StaticFilterReasonCode[] = []): ContextCode[] {
  if (!isAskedBehavior(behavior)) return [];
  const required = new Set<ContextCode>([...BASE_CONTEXTS[behavior], ...reasonCodes.flatMap((code) => REASON_CONTEXTS[code] ?? [])]);
  return CONTEXT_CODES.filter((code) => required.has(code));
}
