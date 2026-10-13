import type { Finding } from '../../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../../evidence/normalizer/evidence-normalizer.types';
import type { AgentPlanningAnalyzerSnapshot, AgentPlanningInputV0_1 } from './agent-planning-input.types';
import type {
  StaticFilterConditionDiagnostic,
  StaticFilterEvidenceRef,
  StaticFilterFindingRef,
  StaticFilterReasonCode,
  StaticFilterResult,
  StaticFilterRuleDiagnostic,
  StaticFilterRuleId,
} from './static-filter.types';

const RULE_VERSION = '0.4.0' as const;
const OBFUSCATION_PREFIX = 'threat-runtime-obfuscation';
const METADATA_LIFECYCLE_PREFIX = 'metadata.lifecycle.';

const KNOWN_THREAT_RULES = new Set([
  'threat-network-reverse-shell', 'threat-filesystem-destruction',
  'threat-filesystem-read', 'threat-runtime-environment-read',
  'threat-network-dns-exfil', 'threat-network-exfil-messenger',
  'threat-process-download-exec', 'threat-process-hooks',
  'threat-npm-preinstall-script', 'threat-runtime-self-propagation',
  'threat-network-exfil-sysinfo', 'threat-network-exfiltration',
  'threat-runtime-keylogging', 'threat-runtime-screencapture',
  'threat-process-memory', 'threat-process-cryptomining',
  'threat-filesystem-autostart', 'threat-process-injection-dll',
]);

const LIFECYCLE_BEHAVIOR_RULES = new Set([
  'capability-process-spawn', 'capability-network-outbound',
  'capability-network-download', 'capability-filesystem-read',
  'capability-filesystem-browser', 'threat-filesystem-read',
  'threat-runtime-environment-read', 'threat-process-download-exec',
  'threat-network-dns-exfil', 'threat-network-exfil-messenger',
  'threat-network-exfil-sysinfo', 'threat-network-exfiltration',
  'threat-network-reverse-shell',
]);

interface IndexedFinding {
  readonly analyzer: AgentPlanningAnalyzerSnapshot;
  readonly finding: Finding;
  readonly ref: StaticFilterFindingRef;
  readonly evidenceRefs: readonly StaticFilterEvidenceRef[];
}

interface EvaluationContext {
  readonly input: AgentPlanningInputV0_1;
  readonly findings: readonly IndexedFinding[];
}

function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function evidenceRefsFor(
  analyzer: string,
  findingId: string,
  evidences: readonly AtomicEvidenceV0_1[],
): StaticFilterEvidenceRef[] {
  return evidences
    .filter((evidence) => evidence.sources.some((source) => (
      source.analyzer === analyzer && source.rawFindingId === findingId
    )))
    .map(({ evidenceId }) => ({ evidenceId }));
}

function indexFindings(input: AgentPlanningInputV0_1): IndexedFinding[] {
  const analyzers = [
    ...input.tier1.analyzers,
    input.tier2.analyzer,
    ...input.tier2.derivedAnalyzers,
  ];
  return analyzers.flatMap((analyzer) => analyzer.findings.map((finding) => ({
    analyzer,
    finding,
    ref: { analyzer: analyzer.analyzer, findingId: finding.findingId },
    evidenceRefs: evidenceRefsFor(
      analyzer.analyzer,
      finding.findingId,
      input.normalization.atomicEvidences,
    ),
  })));
}

function hits(context: EvaluationContext, ruleId: string): IndexedFinding[] {
  return context.findings.filter(({ finding }) => finding.ruleId === ruleId);
}

function prefixHits(context: EvaluationContext, prefix: string): IndexedFinding[] {
  return context.findings.filter(({ finding }) => finding.ruleId.startsWith(prefix));
}

function condition(
  name: string,
  status: StaticFilterConditionDiagnostic['status'],
  detail: string,
): StaticFilterConditionDiagnostic {
  return { condition: name, status, detail };
}

function refs(findings: readonly IndexedFinding[]): StaticFilterFindingRef[] {
  return unique(findings.map(({ ref }) => ref), ({ analyzer, findingId }) => `${analyzer}\0${findingId}`);
}

function evidenceRefs(findings: readonly IndexedFinding[]): StaticFilterEvidenceRef[] {
  return unique(findings.flatMap((finding) => finding.evidenceRefs), ({ evidenceId }) => evidenceId);
}

function diagnostic(
  ruleId: StaticFilterRuleId,
  category: StaticFilterRuleDiagnostic['category'],
  outcome: StaticFilterRuleDiagnostic['outcome'],
  conditions: readonly StaticFilterConditionDiagnostic[],
  findings: readonly IndexedFinding[],
  options: {
    readonly linked?: StaticFilterRuleDiagnostic['linked'];
    readonly blockingConditions?: readonly string[];
  } = {},
): StaticFilterRuleDiagnostic {
  return {
    ruleId,
    category,
    outcome,
    conditions,
    linked: options.linked ?? { required: false, status: 'NOT_REQUIRED', basis: [] },
    findingRefs: refs(findings),
    evidenceRefs: evidenceRefs(findings),
    blockingConditions: options.blockingConditions ?? [],
  };
}

function hitCondition(ruleId: string, findings: readonly IndexedFinding[]): StaticFilterConditionDiagnostic {
  return condition(
    `HIT(${ruleId})`,
    findings.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED',
    findings.length > 0 ? `${findings.length} exact Raw Finding hit(s)` : 'No exact Raw Finding hit',
  );
}

function findingPaths(indexed: IndexedFinding): string[] {
  const location = indexed.finding.location;
  if (location === undefined) return [];
  return unique([
    ...(location.path === undefined ? [] : [location.path]),
    ...(location.derivedFrom?.path === undefined ? [] : [location.derivedFrom.path]),
  ].map(canonicalPath).filter((path) => path.length > 0), (path) => path);
}

function canonicalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function originalPaths(context: EvaluationContext, indexed: IndexedFinding): string[] {
  const paths = findingPaths(indexed);
  if (!indexed.analyzer.analyzer.endsWith('-deobfuscated')) return paths;
  const restore = context.input.tier2.restore;
  if (restore === undefined) return paths;
  const mapped = restore.restored.flatMap((file) => {
    const derivedPaths = [
      canonicalPath(file.outputPath),
      ...(file.lineMapping === undefined ? [] : [canonicalPath(file.lineMapping.derivedPath)]),
      ...file.payloads.flatMap((payload) => [
        canonicalPath(payload.outputPath),
        ...(payload.lineMapping === undefined ? [] : [canonicalPath(payload.lineMapping.derivedPath)]),
      ]),
    ];
    return paths.some((path) => derivedPaths.includes(path))
      ? [canonicalPath(file.path)]
      : [];
  });
  return unique([...paths, ...mapped], (path) => path);
}

function sameFile(context: EvaluationContext, findings: readonly IndexedFinding[]): boolean | undefined {
  if (findings.length < 2) return undefined;
  const paths = findings.map((finding) => originalPaths(context, finding));
  if (paths.some((items) => items.length === 0)) return undefined;
  return paths[0]?.some((path) => paths.slice(1).every((items) => items.includes(path))) ?? false;
}

function hasFindingContext(indexed: IndexedFinding): boolean {
  return indexed.finding.location !== undefined
    && typeof indexed.finding.data === 'object'
    && indexed.finding.data !== null
    && Object.keys(indexed.finding.data).length > 0;
}

function matchingRestoredFile(context: EvaluationContext, indexed: IndexedFinding) {
  if (!indexed.analyzer.analyzer.endsWith('-deobfuscated')) return undefined;
  const paths = findingPaths(indexed);
  return context.input.tier2.restore?.restored.find((file) => {
    const candidates = [
      canonicalPath(file.outputPath),
      ...(file.lineMapping === undefined ? [] : [canonicalPath(file.lineMapping.derivedPath)]),
      ...file.payloads.flatMap((payload) => [
        canonicalPath(payload.outputPath),
        ...(payload.lineMapping === undefined ? [] : [canonicalPath(payload.lineMapping.derivedPath)]),
      ]),
    ];
    return paths.some((path) => candidates.includes(path));
  });
}

function findingValid(context: EvaluationContext, indexed: IndexedFinding): boolean {
  if (!hasFindingContext(indexed)) return false;
  if (indexed.analyzer.status === 'FAILED' || indexed.analyzer.status === 'TIMEOUT') return false;
  if (!indexed.analyzer.analyzer.endsWith('-deobfuscated')) return true;
  const restored = matchingRestoredFile(context, indexed);
  return restored !== undefined
    && restored.status === 'RESTORED'
    && restored.limitations.length === 0
    && restored.validation.original.parse.valid
    && restored.validation.restored.parse.valid
    && restored.lineMapping?.status === 'MAPPED'
    && restored.lineMapping.limitations.length === 0;
}

interface HeuristicMatch {
  readonly anchor: IndexedFinding;
  readonly basis: 'DIRECT_COMMAND_MATCH' | 'SAME_FILE_COMBINATION';
  readonly semanticConditions: readonly StaticFilterConditionDiagnostic[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findingCode(indexed: IndexedFinding): string | undefined {
  const data = asRecord(indexed.finding.data);
  if (typeof data?.code === 'string' && data.code.trim() !== '') return data.code;
  const guarddog = asRecord(data?.guarddog);
  const raw = asRecord(guarddog?.rawResult);
  return typeof raw?.code === 'string' && raw.code.trim() !== '' ? raw.code : undefined;
}

function lifecycleCommand(indexed: IndexedFinding): string | undefined {
  if (!indexed.finding.ruleId.startsWith(METADATA_LIFECYCLE_PREFIX)) return undefined;
  const value = asRecord(indexed.finding.data)?.scriptValue;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Masks comments and string bodies so API names inside examples/literals are not treated as calls. */
function lexicalCodeMask(code: string): string {
  let state: 'CODE' | 'SINGLE' | 'DOUBLE' | 'TEMPLATE' | 'LINE_COMMENT' | 'BLOCK_COMMENT' = 'CODE';
  let escaped = false;
  let output = '';
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    const next = code[index + 1];
    if (state === 'LINE_COMMENT') {
      if (char === '\n') { state = 'CODE'; output += '\n'; } else output += ' ';
      continue;
    }
    if (state === 'BLOCK_COMMENT') {
      if (char === '*' && next === '/') { output += '  '; index += 1; state = 'CODE'; }
      else output += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state !== 'CODE') {
      output += char === '\n' ? '\n' : ' ';
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'SINGLE' && char === "'") || (state === 'DOUBLE' && char === '"')
        || (state === 'TEMPLATE' && char === '`')) state = 'CODE';
      continue;
    }
    if (char === '/' && next === '/') { output += '  '; index += 1; state = 'LINE_COMMENT'; continue; }
    if (char === '/' && next === '*') { output += '  '; index += 1; state = 'BLOCK_COMMENT'; continue; }
    if (char === "'") { output += ' '; state = 'SINGLE'; continue; }
    if (char === '"') { output += ' '; state = 'DOUBLE'; continue; }
    if (char === '`') { output += ' '; state = 'TEMPLATE'; continue; }
    output += char;
  }
  return output;
}

function withoutComments(code: string): string {
  let state: 'CODE' | 'SINGLE' | 'DOUBLE' | 'TEMPLATE' | 'LINE_COMMENT' | 'BLOCK_COMMENT' = 'CODE';
  let escaped = false;
  let output = '';
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index] as string;
    const next = code[index + 1];
    if (state === 'LINE_COMMENT') {
      if (char === '\n') { state = 'CODE'; output += '\n'; } else output += ' ';
      continue;
    }
    if (state === 'BLOCK_COMMENT') {
      if (char === '*' && next === '/') { output += '  '; index += 1; state = 'CODE'; }
      else output += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (state !== 'CODE') {
      output += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((state === 'SINGLE' && char === "'") || (state === 'DOUBLE' && char === '"')
        || (state === 'TEMPLATE' && char === '`')) state = 'CODE';
      continue;
    }
    if (char === '/' && next === '/') { output += '  '; index += 1; state = 'LINE_COMMENT'; continue; }
    if (char === '/' && next === '*') { output += '  '; index += 1; state = 'BLOCK_COMMENT'; continue; }
    if (char === "'") state = 'SINGLE';
    else if (char === '"') state = 'DOUBLE';
    else if (char === '`') state = 'TEMPLATE';
    output += char;
  }
  return output;
}

function callArguments(code: string, openParenthesis: number): string | undefined {
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (let index = openParenthesis; index < code.length; index += 1) {
    const char = code[index] as string;
    if (quote !== undefined) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openParenthesis + 1, index);
    }
  }
  return undefined;
}

function splitArguments(value: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (quote !== undefined) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if ('([{'.includes(char)) depth += 1;
    if (')]}'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) { values.push(value.slice(start, index).trim()); start = index + 1; }
  }
  values.push(value.slice(start).trim());
  return values;
}

function calls(code: string, pattern: RegExp): Array<{ name: string; receiver?: string; args: string[] }> {
  const mask = lexicalCodeMask(code);
  const values: Array<{ name: string; receiver?: string; args: string[] }> = [];
  for (const match of mask.matchAll(pattern)) {
    const whole = match[0];
    const openOffset = whole.lastIndexOf('(');
    const open = (match.index ?? 0) + openOffset;
    const argumentText = callArguments(code, open);
    if (argumentText === undefined) continue;
    values.push({
      name: match.groups?.name ?? '',
      ...(match.groups?.receiver === undefined ? {} : { receiver: match.groups.receiver }),
      args: splitArguments(argumentText),
    });
  }
  return values;
}

const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|AUTH|MNEMONIC|SEED(?:_PHRASE)?)/iu;
const GENERAL_ENV_NAME = /^(?:NODE_ENV|DEBUG|CI|PORT|HOST|HOME|PATH|PWD|SHELL|TERM|LANG)$/iu;

function sensitiveExpression(value: string): { sensitive: boolean; classification?: string } {
  value = withoutComments(value);
  if (/\bprocess\.env\s*(?:[,)}\]])/u.test(value)) {
    return { sensitive: true, classification: 'FULL_ENVIRONMENT' };
  }
  const matches = [...value.matchAll(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])/gu)];
  for (const match of matches) {
    const name = match[1] ?? match[2] ?? '';
    if (CREDENTIAL_NAME.test(name) && !GENERAL_ENV_NAME.test(name)) {
      return { sensitive: true, classification: `CREDENTIAL_ENV:${name}` };
    }
  }
  if (/(?:readFile|readFileSync)\s*\([^)]*(?:\.npmrc|\.ssh|\.aws|\.azure|gcloud|id_rsa|id_ed25519|credentials)/iu.test(value)) {
    return { sensitive: true, classification: 'SENSITIVE_FILE_CONTENT' };
  }
  return { sensitive: false };
}

function externalLiteral(value: string): boolean {
  return /['"`]https?:\/\/(?!localhost\b|127\.0\.0\.1\b|\[?::1\]?\b)/iu.test(withoutComments(value));
}

function hasRequiredModuleBinding(code: string, binding: string, modules: readonly string[]): boolean {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const mask = lexicalCodeMask(code);
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*require\\s*\\(`, 'gu');
  for (const match of mask.matchAll(declaration)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const argument = callArguments(code, open)?.trim().replace(/^['"]|['"]$/gu, '');
    if (argument !== undefined && modules.includes(argument)) return true;
  }
  const importPrefix = new RegExp(`\\bimport\\s+${escaped}\\s+from\\s+`, 'gu');
  for (const match of mask.matchAll(importPrefix)) {
    const suffix = code.slice((match.index ?? 0) + match[0].length);
    const moduleName = /^['"]([^'"]+)['"]/u.exec(suffix)?.[1];
    if (moduleName !== undefined && modules.includes(moduleName)) return true;
  }
  return false;
}

function directNetworkPayload(code: string): { basis: string[]; classification: string } | undefined {
  const networkCalls = calls(code,
    /(?:(?<receiver>[A-Za-z_$][\w$]*)\.)?(?<name>fetch|request|post|put|patch)\s*\(/gu);
  for (const call of networkCalls) {
    const endpoint = call.args[0] ?? '';
    if (!externalLiteral(endpoint)) continue;
    if (call.name !== 'fetch') {
      if (call.receiver === undefined) continue;
      const supported = call.name === 'request'
        ? hasRequiredModuleBinding(code, call.receiver, ['http', 'https', 'node:http', 'node:https'])
        : hasRequiredModuleBinding(code, call.receiver, ['axios']);
      if (!supported) continue;
    }
    let payload = '';
    if (call.name === 'fetch' || call.name === 'request') {
      const options = call.args[1] ?? '';
      const body = /\bbody\s*:\s*([\s\S]*)/u.exec(options)?.[1];
      payload = body ?? (sensitiveExpression(endpoint).sensitive ? endpoint : '');
    } else {
      payload = call.args[1] ?? '';
    }
    if (/\b(?:Authorization|X-Api-Key|X-Auth-Token)\s*:/iu.test(payload)) continue;
    const sensitive = sensitiveExpression(payload);
    if (!sensitive.sensitive || sensitive.classification === undefined) continue;
    return {
      basis: [`DIRECT_NETWORK_DATA_ARGUMENT:${call.receiver === undefined ? call.name : `${call.receiver}.${call.name}`}`],
      classification: sensitive.classification,
    };
  }
  return undefined;
}

function directMessengerPayload(code: string): { basis: string[]; classification: string } | undefined {
  const mask = lexicalCodeMask(code);
  for (const call of calls(code, /(?<receiver>[A-Za-z_$][\w$]*)\.(?<name>sendMessage)\s*\(/gu)) {
    if (call.receiver === undefined || call.args.length < 2) continue;
    const escaped = call.receiver.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*new\\s+TelegramBot\\s*\\(`, 'u').test(mask)) continue;
    if (!hasRequiredModuleBinding(code, 'TelegramBot', ['node-telegram-bot-api'])) continue;
    const sensitive = sensitiveExpression(call.args[1] ?? '');
    if (!sensitive.sensitive || sensitive.classification === undefined) continue;
    return {
      basis: [`DIRECT_MESSENGER_MESSAGE_ARGUMENT:${call.receiver}.sendMessage:argument-2`],
      classification: sensitive.classification,
    };
  }
  return undefined;
}

function directDnsPayload(code: string): { basis: string[]; classification: string } | undefined {
  const mask = lexicalCodeMask(code);
  if (!/(?:require\(\s*['"](?:node:)?dns['"]\s*\)|from\s+['"](?:node:)?dns['"])/u.test(withoutComments(code))) return undefined;
  for (const call of calls(code, /(?<receiver>[A-Za-z_$][\w$]*)\.(?<name>resolve|resolveTxt|lookup)\s*\(/gu)) {
    if (call.receiver === undefined || !new RegExp(`\\b${call.receiver.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u').test(mask)) continue;
    const sensitive = sensitiveExpression(call.args[0] ?? '');
    if (!sensitive.sensitive || sensitive.classification === undefined) continue;
    return { basis: [`DIRECT_DNS_QUERY_ARGUMENT:${call.receiver}.${call.name}:argument-1`], classification: sensitive.classification };
  }
  return undefined;
}

function directReverseShell(code: string, allowBareCommand = false): string[] | undefined {
  const reverse = /(?:\/dev\/tcp\/|\bnc\b[^\n]*\s-e\s|\bbash\s+-i\b|\bpowershell\b[^\n]*(?:TcpClient|NetworkStream))/iu;
  if (allowBareCommand && reverse.test(code)) return ['DIRECT_LIFECYCLE_COMMAND', 'REVERSE_SHELL_COMMAND'];
  for (const call of calls(code,
    /(?:(?<receiver>[A-Za-z_$][\w$]*)\.)?(?<name>exec|execSync|execFile|spawn|spawnSync|fork)\s*\(/gu)) {
    const command = withoutComments(call.args.slice(0, 2).join(' '));
    if (reverse.test(command)) return [`DIRECT_PROCESS_ARGUMENT:${call.name}`, 'REVERSE_SHELL_COMMAND'];
  }
  return undefined;
}

function directDestructiveExecution(code: string, allowBareCommand = false): string[] | undefined {
  const destructive = /(?:\brm\s+(?:-[A-Za-z]*[rf][A-Za-z]*\s+)+(?:\/(?:etc|usr|var|home|root|boot|opt|srv)(?:\/|\b)|\$HOME\b|~\/)|\b(?:del|erase)\s+\/s\s+(?:[A-Za-z]:\\|\\\\)|\bformat\s+[A-Za-z]:|>{1,2}\s*\/(?:etc|usr|boot)\/)/iu;
  const excluded = /(?:\/tmp\b|\bcache\b|\bnode_modules\b|\bbuild\b|\bdist\b)/iu;
  if (allowBareCommand && destructive.test(code) && !excluded.test(code)) {
    return ['DIRECT_LIFECYCLE_COMMAND', 'IMPORTANT_PATH_DESTRUCTION'];
  }
  for (const call of calls(code,
    /(?:(?<receiver>[A-Za-z_$][\w$]*)\.)?(?<name>exec|execSync|execFile|spawn|spawnSync|fork)\s*\(/gu)) {
    const command = withoutComments(call.args.slice(0, 2).join(' '));
    if (destructive.test(command) && !excluded.test(command)) {
      return [`DIRECT_PROCESS_ARGUMENT:${call.name}`, 'IMPORTANT_PATH_DESTRUCTION'];
    }
  }
  return undefined;
}

function reverseShellCommand(code: string): boolean {
  const value = withoutComments(code);
  if (/\b(?:example|sample|demo)\b/iu.test(value)) return false;
  return /(?:\/dev\/tcp\/|\bnc\b[^\n]*\s-e\s|\bbash\s+-i\b|\bpowershell\b[^\n]*(?:TcpClient|NetworkStream))/iu.test(value);
}

function importantDestructiveCommand(code: string): boolean {
  const value = withoutComments(code);
  if (/\b(?:example|sample|demo)\b/iu.test(value)) return false;
  return directDestructiveExecution(value, true) !== undefined;
}

function sensitiveCollection(code: string): { classification: string } | undefined {
  const result = sensitiveExpression(code);
  if (!result.sensitive || result.classification === undefined) return undefined;
  if (/\b(?:Authorization|X-Api-Key|X-Auth-Token)\s*:\s*[^,}\n]*process\.env/iu.test(withoutComments(code))) {
    return undefined;
  }
  return { classification: result.classification };
}

function explicitNormalExfilUse(code: string): boolean {
  const messenger = calls(code, /(?<receiver>[A-Za-z_$][\w$]*)\.(?<name>sendMessage)\s*\(/gu)
    .some((call) => call.args.length >= 2
      && /^['"`][^'"`]*(?:hello|status|ready|started|complete)[^'"`]*['"`]$/iu.test(call.args[1]?.trim() ?? '')
      && !sensitiveExpression(call.args[1] ?? '').sensitive);
  const dns = calls(code, /(?<receiver>[A-Za-z_$][\w$]*)\.(?<name>resolve|resolveTxt|lookup)\s*\(/gu)
    .some((call) => /^['"`][A-Za-z0-9.-]+['"`]$/u.test(call.args[0]?.trim() ?? '')
      && !sensitiveExpression(call.args[0] ?? '').sensitive);
  return messenger || dns;
}

function representativesOnAnchorPath(
  context: EvaluationContext,
  groups: readonly (readonly IndexedFinding[])[],
  anchor: IndexedFinding,
): IndexedFinding[] | undefined {
  const anchorPaths = originalPaths(context, anchor);
  if (anchorPaths.length === 0) return undefined;
  const representatives: IndexedFinding[] = [];
  for (const group of groups) {
    const representative = group.find((finding) => findingValid(context, finding)
      && originalPaths(context, finding).some((path) => anchorPaths.includes(path)));
    if (representative === undefined) return undefined;
    representatives.push(representative);
  }
  return unique([...representatives, anchor], ({ ref }) => `${ref.analyzer}\0${ref.findingId}`);
}

function heuristicDiagnostic(
  context: EvaluationContext,
  ruleId: Extract<StaticFilterRuleId, `M${string}`>,
  groups: readonly (readonly IndexedFinding[])[],
  candidates: readonly IndexedFinding[],
  inspect: (code: string) => HeuristicMatch['semanticConditions'] | undefined,
  basis: HeuristicMatch['basis'],
  requireSameFile: boolean,
): StaticFilterRuleDiagnostic {
  const matched = groups.flat();
  const allHits = groups.every((group) => group.length > 0);
  let match: HeuristicMatch | undefined;
  let used: IndexedFinding[] = matched;
  for (const candidate of candidates) {
    if (!findingValid(context, candidate)) continue;
    const code = findingCode(candidate);
    if (code === undefined) continue;
    const semanticConditions = inspect(code);
    if (semanticConditions === undefined) continue;
    const representatives = requireSameFile
      ? representativesOnAnchorPath(context, groups, candidate)
      : [candidate];
    if (representatives === undefined) continue;
    match = { anchor: candidate, basis, semanticConditions };
    used = representatives;
    break;
  }
  const validity = used.length > 0 && used.every((finding) => findingValid(context, finding));
  const sameFileStatus = requireSameFile
    ? (match === undefined ? sameFile(context, matched) : true)
    : undefined;
  const conditions = [
    ...groups.map((group) => hitCondition([...new Set(group.map(({ finding }) => finding.ruleId))].join(' OR '), group)),
    condition('VALID', validity ? 'SATISFIED' : matched.length === 0 ? 'NOT_SATISFIED' : 'UNVERIFIED',
      validity ? 'All Findings used by the heuristic are valid' : 'Required Finding validity is not established'),
    ...(requireSameFile ? [condition('SAME_FILE', sameFileStatus === true ? 'SATISFIED'
      : sameFileStatus === false ? 'NOT_SATISFIED' : 'UNVERIFIED',
    sameFileStatus === true ? 'Full path or restore provenance matches'
      : sameFileStatus === false ? 'Required Findings resolve to different original files'
        : 'Required Finding paths cannot be compared')] : []),
    condition(basis, match === undefined ? 'UNVERIFIED' : 'SATISFIED',
      match === undefined ? 'Required semantic evidence is not established by the available matching context'
        : basis === 'SAME_FILE_COMBINATION'
          ? 'Predefined rule combination and semantic evidence occur in the same original file; data flow is not verified'
          : 'The matching context contains the predefined command pattern; execution is not verified'),
    ...match?.semanticConditions ?? [],
  ];
  const satisfied = allHits && match !== undefined && validity
    && (!requireSameFile || sameFileStatus === true)
    && conditions.every(({ status }) => status === 'SATISFIED');
  return diagnostic(ruleId, 'MALICIOUS', satisfied ? 'SATISFIED' : allHits ? 'UNVERIFIED' : 'NOT_APPLICABLE', conditions, used, {
    linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
    blockingConditions: allHits ? conditions.filter(({ status }) => status !== 'SATISFIED').map(({ condition: name }) => name) : [],
  });
}

function disabledMaliciousRule(
  ruleId: 'M06' | 'M08',
  groups: readonly (readonly IndexedFinding[])[],
): StaticFilterRuleDiagnostic {
  const findings = groups.flat();
  const allHits = groups.every((group) => group.length > 0);
  return diagnostic(ruleId, 'MALICIOUS', allHits ? 'UNVERIFIED' : 'NOT_APPLICABLE', [
    ...groups.map((group) => hitCondition([...new Set(group.map(({ finding }) => finding.ruleId))].join(' OR '), group)),
    condition('INDEPENDENT_MALICIOUS_CONFIRMATION_DISABLED', allHits ? 'UNVERIFIED' : 'NOT_SATISFIED',
      `${ruleId} is intentionally retained as ambiguity context and cannot independently confirm maliciousness`),
  ], findings, {
    linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
    blockingConditions: allHits ? ['INDEPENDENT_MALICIOUS_CONFIRMATION_DISABLED'] : [],
  });
}

function evaluateMalicious(context: EvaluationContext): StaticFilterRuleDiagnostic[] {
  const reverse = hits(context, 'threat-network-reverse-shell');
  const destruction = hits(context, 'threat-filesystem-destruction');
  const spawn = hits(context, 'capability-process-spawn');
  const fileThreat = hits(context, 'threat-filesystem-read');
  const fileCapability = hits(context, 'capability-filesystem-read');
  const env = hits(context, 'threat-runtime-environment-read');
  const outbound = hits(context, 'capability-network-outbound');
  const dns = hits(context, 'threat-network-dns-exfil');
  const messenger = hits(context, 'threat-network-exfil-messenger');
  const downloadExec = hits(context, 'threat-process-download-exec');
  const download = hits(context, 'capability-network-download');
  const hooks = [...hits(context, 'threat-process-hooks'), ...hits(context, 'threat-npm-preinstall-script'),
    ...prefixHits(context, METADATA_LIFECYCLE_PREFIX)];
  const propagation = hits(context, 'threat-runtime-self-propagation');

  const m01 = heuristicDiagnostic(context, 'M01', [reverse], reverse, (code) => reverseShellCommand(code) ? [
    condition('ACTUAL_SHELL_CONNECTION_COMMAND', 'SATISFIED', 'A reverse-shell command pattern is present in matching context'),
  ] : undefined, 'DIRECT_COMMAND_MATCH', false);
  const m02 = heuristicDiagnostic(context, 'M02', [destruction, spawn], destruction,
    (code) => importantDestructiveCommand(code) ? [
      condition('IMPORTANT_PATH_DESTRUCTION', 'SATISFIED', 'An important-path destructive command is present'),
    ] : undefined, 'SAME_FILE_COMBINATION', true);
  const m03 = heuristicDiagnostic(context, 'M03', [fileThreat, fileCapability, outbound], [...fileThreat, ...fileCapability],
    (code) => sensitiveCollection(code)?.classification === 'SENSITIVE_FILE_CONTENT' ? [
      condition('SENSITIVE_FILE_READ', 'SATISFIED', 'A sensitive-file read call, not only a path string, is present'),
    ] : undefined, 'SAME_FILE_COMBINATION', true);
  const m04 = heuristicDiagnostic(context, 'M04', [env, outbound], env, (code) => {
    const collection = sensitiveCollection(code);
    return collection === undefined ? undefined : [
      condition('SENSITIVE_DATA_CLASSIFIED', 'SATISFIED', collection.classification),
      condition('NORMAL_USE_EXCLUSION', 'SATISFIED', 'No general-setting-only or explicit normal-auth use was observed'),
    ];
  }, 'SAME_FILE_COMBINATION', true);

  const collection = [...env, ...fileThreat, ...fileCapability];
  const exfilThreats = [...dns, ...messenger];
  const m05Candidates = collection.filter((candidate) => {
    const paths = originalPaths(context, candidate);
    return !exfilThreats.some((threat) => {
      const threatCode = findingCode(threat);
      return originalPaths(context, threat).some((path) => paths.includes(path))
        && threatCode !== undefined && explicitNormalExfilUse(threatCode);
    });
  });
  const m05 = heuristicDiagnostic(context, 'M05', [exfilThreats, collection], m05Candidates, (code) => {
    const collected = sensitiveCollection(code);
    return collected === undefined ? undefined : [
      condition('SENSITIVE_COLLECTION', 'SATISFIED', collected.classification),
      condition('NORMAL_USE_EXCLUSION', 'SATISFIED', 'No explicit general-DNS or normal-message use was observed in the matching evidence'),
    ];
  }, 'SAME_FILE_COMBINATION', true);

  const m06 = disabledMaliciousRule('M06', [downloadExec, download, spawn]);
  const lifecycleCommands = hooks.filter((finding) => lifecycleCommand(finding) !== undefined);
  const prior = [m01, m02, m03, m04, m05];
  const confirmedPrior = prior.filter(({ outcome }) => outcome === 'SATISFIED');
  const lifecycleCoupling = lifecycleCommands.find((finding) => {
    const command = lifecycleCommand(finding);
    if (command === undefined) return false;
    return confirmedPrior.some(({ ruleId }) => {
      if (ruleId === 'M01') return directReverseShell(command, true) !== undefined;
      if (ruleId === 'M02') return directDestructiveExecution(command, true) !== undefined;
      if (ruleId === 'M03') return directNetworkPayload(command)?.classification === 'SENSITIVE_FILE_CONTENT';
      if (ruleId === 'M04') return directNetworkPayload(command) !== undefined;
      if (ruleId === 'M05') return directMessengerPayload(command) !== undefined || directDnsPayload(command) !== undefined;
      return false;
    });
  });
  const m07Ready = confirmedPrior.length > 0 && lifecycleCoupling !== undefined;
  const m07Findings = [...hooks, ...confirmedPrior.flatMap(({ findingRefs }) => context.findings.filter(({ ref }) =>
    findingRefs.some((value) => value.analyzer === ref.analyzer && value.findingId === ref.findingId)))];
  const m07 = diagnostic('M07', 'MALICIOUS', m07Ready ? 'SATISFIED' : hooks.length > 0 ? 'UNVERIFIED' : 'NOT_APPLICABLE', [
    condition('LIFECYCLE_CONTEXT', hooks.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED', 'Lifecycle Finding or metadata script'),
    condition('SCOPED_M01_TO_M05_SATISFIED', confirmedPrior.length > 0 ? 'SATISFIED' : 'UNVERIFIED',
      'M07 adds installation context and does not cancel independent M01-M05 confirmation'),
    condition('LIFECYCLE_DIRECT_MALICIOUS_COMMAND', lifecycleCoupling === undefined ? 'UNVERIFIED' : 'SATISFIED',
      lifecycleCoupling === undefined ? 'No lifecycle command directly contains a confirmed supported malicious command' : 'Lifecycle script directly contains the malicious command'),
  ], m07Findings, {
    linked: hooks.length > 0 ? { required: true, status: m07Ready ? 'CONFIRMED' : 'UNVERIFIED',
      basis: m07Ready ? ['DIRECT_LIFECYCLE_COMMAND'] : [] } : { required: true, status: 'NOT_REQUIRED', basis: [] },
    blockingConditions: hooks.length > 0 && !m07Ready
      ? ['SCOPED_M01_TO_M05_SATISFIED', 'LIFECYCLE_DIRECT_MALICIOUS_COMMAND'] : [],
  });
  const m08 = disabledMaliciousRule('M08', [propagation, spawn]);
  return [m01, m02, m03, m04, m05, m06, m07, m08];
}

function ambiguityRule(
  context: EvaluationContext,
  ruleId: Extract<StaticFilterRuleId, `A${string}`>,
  findings: readonly IndexedFinding[],
  conditions: readonly StaticFilterConditionDiagnostic[],
  reason: string,
): StaticFilterRuleDiagnostic {
  return diagnostic(
    ruleId,
    'AMBIGUOUS',
    findings.length > 0 ? 'UNVERIFIED' : 'NOT_APPLICABLE',
    conditions,
    findings,
    {
      linked: { required: true, status: findings.length > 0 ? 'UNVERIFIED' : 'NOT_REQUIRED', basis: [] },
      blockingConditions: findings.length > 0 ? [reason] : [],
    },
  );
}

function unresolvedFor(context: EvaluationContext, indexed: IndexedFinding): boolean {
  const paths = originalPaths(context, indexed);
  return context.input.tier2.restore?.unresolved.some((file) => (
    paths.includes(canonicalPath(file.path))
  )) ?? false;
}

function limitedRestoreFor(context: EvaluationContext, indexed: IndexedFinding): boolean {
  const paths = originalPaths(context, indexed);
  return context.input.tier2.restore?.restored.some((file) => (
    paths.includes(canonicalPath(file.path))
    && (file.status === 'PARTIAL_RESTORED' || file.limitations.length > 0)
  )) ?? false;
}

function evaluateAmbiguities(context: EvaluationContext): StaticFilterRuleDiagnostic[] {
  const obfuscation = prefixHits(context, OBFUSCATION_PREFIX);
  const a01Findings = obfuscation.filter((finding) => (
    unresolvedFor(context, finding) || limitedRestoreFor(context, finding)
  ));
  const fileRead = hits(context, 'threat-filesystem-read');
  const envRead = hits(context, 'threat-runtime-environment-read');
  const outbound = hits(context, 'capability-network-outbound');
  const downloadExec = hits(context, 'threat-process-download-exec');
  const download = hits(context, 'capability-network-download');
  const spawn = hits(context, 'capability-process-spawn');
  const lifecycle = [
    ...hits(context, 'threat-process-hooks'),
    ...hits(context, 'threat-npm-preinstall-script'),
    ...prefixHits(context, METADATA_LIFECYCLE_PREFIX),
  ];
  const lifecycleBehavior = context.findings.filter(({ finding }) => LIFECYCLE_BEHAVIOR_RULES.has(finding.ruleId));
  const exfil = context.findings.filter(({ finding }) => [
    'threat-network-dns-exfil', 'threat-network-exfil-messenger',
    'threat-network-exfil-sysinfo', 'threat-network-exfiltration',
  ].includes(finding.ruleId));
  const dualUse = context.findings.filter(({ finding }) => [
    'threat-runtime-keylogging', 'threat-runtime-screencapture', 'threat-process-memory',
    'threat-process-cryptomining', 'threat-filesystem-autostart',
    'threat-process-injection-dll',
  ].includes(finding.ruleId));
  const propagation = hits(context, 'threat-runtime-self-propagation');
  const relationAnalyzers = [
    ...context.input.tier1.analyzers,
    ...context.input.tier2.derivedAnalyzers,
  ].filter((analyzer) => (analyzer.customRule?.relationCandidates.length ?? 0) > 0);
  const hasRelation = relationAnalyzers.length > 0;
  const relationFindings = context.findings.filter(({ analyzer, finding }) => {
    if (!relationAnalyzers.includes(analyzer)) return false;
    return analyzer.customRule?.relationCandidates.some((candidate) => (
      candidate.sourceFindingIds.includes(finding.findingId)
      || candidate.sinkFindingIds.includes(finding.findingId)
    )) ?? false;
  });
  return [
    ambiguityRule(context, 'A01', a01Findings, [condition(
      `PREFIX(${OBFUSCATION_PREFIX}) + RELATED_RESTORE_PROBLEM`,
      a01Findings.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED',
      'Exact path/provenance mapping is required',
    )], 'OBFUSCATION_UNRESOLVED'),
    ambiguityRule(context, 'A02', fileRead.length > 0 && outbound.length > 0 ? [...fileRead, ...outbound] : [], [
      hitCondition('threat-filesystem-read', fileRead), hitCondition('capability-network-outbound', outbound),
      condition('COLLECTED_DATA_TO_NETWORK', 'UNVERIFIED', 'No verified data-flow assertion is present'),
    ], 'BEHAVIOR_LINK_UNVERIFIED'),
    ambiguityRule(context, 'A03', envRead.length > 0 && outbound.length > 0 ? [...envRead, ...outbound] : [], [
      hitCondition('threat-runtime-environment-read', envRead), hitCondition('capability-network-outbound', outbound),
      condition('ENV_DATA_TO_NETWORK', 'UNVERIFIED', 'No verified data-flow assertion is present'),
    ], 'BEHAVIOR_LINK_UNVERIFIED'),
    ambiguityRule(context, 'A04', downloadExec.length > 0 || (download.length > 0 && spawn.length > 0)
      ? [...downloadExec, ...download, ...spawn] : [], [
      condition('DOWNLOAD_EXECUTION_REQUIRED_HITS', downloadExec.length > 0 || (download.length > 0 && spawn.length > 0)
        ? 'SATISFIED' : 'NOT_SATISFIED', 'Raw rule combinations only'),
      condition('DOWNLOAD_TO_EXECUTION_OR_PAYLOAD_MALICE', 'UNVERIFIED', 'No verified payload linkage/content is present'),
    ], 'PAYLOAD_CONTENT_UNVERIFIED'),
    ambiguityRule(context, 'A05', lifecycle.length > 0 && lifecycleBehavior.length > 0
      ? [...lifecycle, ...lifecycleBehavior] : [], [
      condition('LIFECYCLE_FINDING', lifecycle.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED', 'Threat hook, preinstall, or metadata lifecycle Finding'),
      condition('PROCESS_NETWORK_OR_SENSITIVE_FINDING', lifecycleBehavior.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED', 'Uses the documented static-filter behavior rule list'),
      condition('LIFECYCLE_CALL_LINK', 'UNVERIFIED', 'Coexistence does not prove invocation'),
    ], 'LIFECYCLE_LINK_UNVERIFIED'),
    ambiguityRule(context, 'A06', exfil, [condition(
      'EXFILTRATION_THREAT_HIT', exfil.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED',
      'DNS, messenger, sysinfo, or generic exfiltration exact rule hit',
    ), condition('SENSITIVE_DATA_AND_DESTINATION_LINK', 'UNVERIFIED', 'Transfer content and target are not linked')], 'BEHAVIOR_LINK_UNVERIFIED'),
    ambiguityRule(context, 'A07', dualUse, [condition(
      'DUAL_USE_THREAT_HIT', dualUse.length > 0 ? 'SATISFIED' : 'NOT_SATISFIED',
      'Keylogging, screen capture, memory, cryptomining, autostart, or DLL injection',
    ), condition('ABUSE_OR_BENIGN_CONTEXT', 'UNVERIFIED', 'Intent/context is not established')], 'DUAL_USE_CONTEXT_UNRESOLVED'),
    ambiguityRule(context, 'A08', propagation, [
      hitCondition('threat-runtime-self-propagation', propagation),
      condition('INSERTION_TO_PUBLISH_LINK', 'UNVERIFIED', 'Propagation chain is not established'),
    ], 'PROPAGATION_LINK_UNVERIFIED'),
    diagnostic('A09', 'AMBIGUOUS', hasRelation ? 'UNVERIFIED' : 'NOT_APPLICABLE', [condition(
      'RELATION_CANDIDATE_PRESENT', hasRelation ? 'SATISFIED' : 'NOT_SATISFIED',
      'Candidates remain unverified even when referenced Findings exist',
    )], relationFindings, {
      linked: { required: true, status: hasRelation ? 'UNVERIFIED' : 'NOT_REQUIRED', basis: [] },
      blockingConditions: hasRelation ? ['RELATION_CANDIDATE_IS_NOT_VERIFIED'] : [],
    }),
    diagnostic('A10', 'AMBIGUOUS', 'NOT_APPLICABLE', [condition(
      'SEMANTIC_REPRESENTATION_CONFLICT', 'UNVERIFIED',
      'Current input has no semantic conflict assertion; Finding count/rule differences are insufficient',
    )], [], { blockingConditions: ['REPRESENTATION_CONFLICT_CANNOT_BE_DERIVED'] }),
  ];
}

function incompleteDiagnostic(
  ruleId: Extract<StaticFilterRuleId, `I${string}`>,
  applied: boolean,
  findings: readonly IndexedFinding[],
  conditionName: string,
  detail: string,
): StaticFilterRuleDiagnostic {
  return diagnostic(ruleId, 'INCOMPLETE', applied ? 'UNVERIFIED' : 'NOT_APPLICABLE', [
    condition(conditionName, applied ? 'SATISFIED' : 'NOT_SATISFIED', detail),
  ], findings, { blockingConditions: applied ? [conditionName] : [] });
}

function missingDirectEvidence(context: EvaluationContext): IndexedFinding[] {
  const combinations: readonly (readonly string[])[] = [
    ['threat-network-reverse-shell'],
    ['threat-filesystem-destruction', 'capability-process-spawn'],
    ['threat-filesystem-read', 'capability-filesystem-read', 'capability-network-outbound'],
    ['threat-runtime-environment-read', 'capability-network-outbound'],
  ];
  const missing = combinations.flatMap((ruleIds) => {
    const groups = ruleIds.map((ruleId) => hits(context, ruleId));
    if (!groups.every((group) => group.length > 0)) return [];
    const findings = groups.flat();
    return findings.every((finding) => findingCode(finding) === undefined) ? findings : [];
  });
  const m05Transport = [
    ...hits(context, 'threat-network-dns-exfil'),
    ...hits(context, 'threat-network-exfil-messenger'),
  ];
  const m05Collection = [
    ...hits(context, 'threat-runtime-environment-read'),
    ...hits(context, 'threat-filesystem-read'),
    ...hits(context, 'capability-filesystem-read'),
  ];
  if (m05Transport.length > 0 && m05Collection.length > 0
    && [...m05Transport, ...m05Collection].every((finding) => findingCode(finding) === undefined)) {
    missing.push(...m05Transport, ...m05Collection);
  }
  return unique(missing, ({ ref }) => `${ref.analyzer}\0${ref.findingId}`);
}

function evaluateIncomplete(context: EvaluationContext): StaticFilterRuleDiagnostic[] {
  const relevant = context.findings.filter(({ finding }) => (
    finding.ruleId.startsWith('threat-') || finding.ruleId.startsWith('capability-')
  ));
  const incompleteAnalyzers = [
    ...context.input.tier1.analyzers,
    context.input.tier2.analyzer,
    ...context.input.tier2.derivedAnalyzers,
  ].filter((analyzer) => analyzer.status === 'FAILED' || analyzer.status === 'TIMEOUT'
    || analyzer.status === 'PARTIAL' || analyzer.errors.length > 0);
  const incompleteFindings = context.findings.filter(({ analyzer }) => incompleteAnalyzers.includes(analyzer));
  const missingContext = unique([
    ...relevant.filter((finding) => !hasFindingContext(finding)),
    ...missingDirectEvidence(context),
  ], ({ ref }) => `${ref.analyzer}\0${ref.findingId}`);
  const rawKeys = new Set(context.findings.map(({ ref }) => `${ref.analyzer}\0${ref.findingId}`));
  const normalizationGap = context.input.normalization.unmappedFindings.filter((finding) => (
    finding.ruleId !== undefined
    && (finding.ruleId.startsWith('threat-') || finding.ruleId.startsWith('capability-'))
    && (finding.findingId === undefined || !rawKeys.has(`${finding.analyzerName}\0${finding.findingId}`))
  ));
  const restorationRelevant = relevant.filter((finding) => (
    unresolvedFor(context, finding) || limitedRestoreFor(context, finding)
  ));
  const budgetRelevant = context.input.tier2.restore?.budgetExceeded === true
    && restorationRelevant.length > 0;
  const provenanceMissing = relevant.filter((finding) => {
    if (!finding.analyzer.analyzer.endsWith('-deobfuscated')) return false;
    const restored = matchingRestoredFile(context, finding);
    return restored === undefined || restored.lineMapping === undefined
      || restored.lineMapping.status !== 'MAPPED';
  });
  return [
    incompleteDiagnostic('I01', incompleteAnalyzers.length > 0, incompleteFindings,
      'ANALYZER_INCOMPLETE', 'FAILED/TIMEOUT/PARTIAL or analyzer errors; affected scope cannot be proven irrelevant'),
    incompleteDiagnostic('I02', missingContext.length > 0, missingContext,
      'REQUIRED_FINDING_CONTEXT_MISSING', 'Relevant Finding lacks location, structured data, or required direct matching code'),
    incompleteDiagnostic('I03', normalizationGap.length > 0, [],
      'RELEVANT_FINDING_UNAVAILABLE_TO_FILTER', `${normalizationGap.length} relevant unmapped item(s) lack a matching Raw Finding`),
    incompleteDiagnostic('I04', restorationRelevant.length > 0, restorationRelevant,
      'RELATED_RESTORATION_INCOMPLETE', 'Exact path/provenance match has unresolved or limited restoration'),
    incompleteDiagnostic('I05', budgetRelevant, restorationRelevant,
      'BUDGET_EXCEEDED_WITH_RELEVANT_UNRESOLVED_TARGET', 'Restore budget was exceeded for a relevant unresolved target'),
    incompleteDiagnostic('I06', provenanceMissing.length > 0, provenanceMissing,
      'DERIVED_PROVENANCE_INCOMPLETE', 'Relevant derived Finding cannot be mapped to a restored original file'),
    incompleteDiagnostic('I07', false, [], 'RECORDED_SCAN_COVERAGE_GAP',
      'No scan coverage-gap field exists in AgentPlanningInputV0_1; counts are not used to infer one'),
    incompleteDiagnostic('I08', true, [], 'SCAN_COVERAGE_UNKNOWN',
      'AgentPlanningInputV0_1 has no complete coverage record, including Custom Rule P0 omissions'),
    incompleteDiagnostic('I09', false, [], 'HANDOFF_EVIDENCE_GAP',
      'No proven Adapter transfer loss is present; relation reference mismatch is not transfer loss'),
  ];
}

function reasonsFor(
  diagnostics: readonly StaticFilterRuleDiagnostic[],
  hasUnclassifiedThreat: boolean,
): StaticFilterReasonCode[] {
  const reasons: StaticFilterReasonCode[] = [];
  const applied = new Set(diagnostics.filter(({ outcome }) => outcome !== 'NOT_APPLICABLE').map(({ ruleId }) => ruleId));
  if ([...applied].some((id) => id.startsWith('M'))) reasons.push('REQUIRED_RULE_HITS_PRESENT');
  if (diagnostics.some(({ category, outcome }) => category === 'MALICIOUS' && outcome === 'SATISFIED')) reasons.push('MALICIOUS_RULE_SATISFIED');
  if (['A02', 'A03', 'A06'].some((id) => applied.has(id as StaticFilterRuleId))) reasons.push('BEHAVIOR_LINK_UNVERIFIED');
  if (applied.has('A04')) reasons.push('PAYLOAD_CONTENT_UNVERIFIED');
  if (applied.has('A05')) reasons.push('LIFECYCLE_LINK_UNVERIFIED');
  if (applied.has('A08')) reasons.push('PROPAGATION_LINK_UNVERIFIED');
  if (applied.has('A01')) reasons.push('OBFUSCATION_UNRESOLVED');
  if (applied.has('A07')) reasons.push('DUAL_USE_CONTEXT_UNRESOLVED');
  if (applied.has('A09')) reasons.push('RELATION_CANDIDATE_UNVERIFIED');
  if (hasUnclassifiedThreat) reasons.push('UNCLASSIFIED_THREAT_REVIEW_REQUIRED');
  if (applied.has('I01')) reasons.push('ANALYZER_INCOMPLETE', 'ANALYZER_SCOPE_RELEVANCE_UNKNOWN');
  if (applied.has('I02')) reasons.push('EVIDENCE_CONTEXT_MISSING');
  if (applied.has('I03')) reasons.push('NORMALIZATION_GAP');
  if (applied.has('I04')) reasons.push('RESTORATION_INCOMPLETE');
  if (applied.has('I05')) reasons.push('RESTORATION_BUDGET_EXCEEDED');
  if (applied.has('I06')) reasons.push('PROVENANCE_INCOMPLETE');
  if (applied.has('I08')) reasons.push('SCAN_COVERAGE_UNKNOWN');
  return unique(reasons, (reason) => reason);
}

/** Status precedence kept separate so it can be verified without inventing input evidence. */
export function resolveStaticFilterStatus(input: {
  readonly hasMalicious: boolean;
  readonly hasThreat: boolean;
  readonly hasIncomplete: boolean;
}): StaticFilterResult['status'] {
  if (input.hasMalicious) return 'STATIC_MALICIOUS';
  if (!input.hasThreat) return 'NO_ESCALATION_SIGNAL';
  if (input.hasIncomplete) return 'STATIC_INCOMPLETE';
  return 'AMBIGUOUS';
}

function isThreatFinding({ finding }: IndexedFinding): boolean {
  return finding.ruleId.startsWith('threat-')
    || finding.type === 'THREAT_INDICATOR'
    || finding.type === 'THREAT';
}

/** Raw Finding threat presence across Tier 1, Tier 2, and derived snapshots. */
export function collectThreatFindingRefs(input: AgentPlanningInputV0_1): readonly StaticFilterFindingRef[] {
  return unique(indexFindings(input).filter(isThreatFinding).map(({ ref }) => ref),
    ({ analyzer, findingId }) => `${analyzer}\0${findingId}`);
}

/** Pure, deterministic static triage. It does not mutate or enrich its input. */
export function evaluateStaticFilter(input: AgentPlanningInputV0_1): StaticFilterResult {
  const context: EvaluationContext = { input, findings: indexFindings(input) };
  const diagnostics = [
    ...evaluateMalicious(context),
    ...evaluateAmbiguities(context),
    ...evaluateIncomplete(context),
  ];
  const appliedRuleIds = diagnostics
    .filter(({ outcome }) => outcome !== 'NOT_APPLICABLE')
    .map(({ ruleId }) => ruleId);
  const hasMalicious = diagnostics.some(({ category, outcome }) => (
    category === 'MALICIOUS' && outcome === 'SATISFIED'
  ));
  const hasIncomplete = diagnostics.some(({ category, outcome }) => (
    category === 'INCOMPLETE' && outcome !== 'NOT_APPLICABLE'
  ));
  const threatFindingRefs = collectThreatFindingRefs(input);
  const hasThreat = threatFindingRefs.length > 0;
  const hasUnclassifiedThreat = context.findings.some(({ finding }) => (
    finding.ruleId.startsWith('threat-')
    && !KNOWN_THREAT_RULES.has(finding.ruleId)
    && !finding.ruleId.startsWith(OBFUSCATION_PREFIX)
  ));
  const status = resolveStaticFilterStatus({
    hasMalicious,
    hasThreat,
    hasIncomplete,
  });
  const appliedDiagnostics = diagnostics.filter(({ outcome }) => outcome !== 'NOT_APPLICABLE');
  const reasonCodes = reasonsFor(diagnostics, hasUnclassifiedThreat);
  if (!hasThreat) reasonCodes.push('NO_THREAT_FINDING');
  return {
    status,
    ruleVersion: RULE_VERSION,
    threat: { present: hasThreat, findingRefs: threatFindingRefs },
    appliedRuleIds,
    reasonCodes,
    findingRefs: unique(appliedDiagnostics.flatMap(({ findingRefs }) => findingRefs),
      ({ analyzer, findingId }) => `${analyzer}\0${findingId}`),
    evidenceRefs: unique(appliedDiagnostics.flatMap(({ evidenceRefs }) => evidenceRefs),
      ({ evidenceId }) => evidenceId),
    diagnostics,
  };
}
