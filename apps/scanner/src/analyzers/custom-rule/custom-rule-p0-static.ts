import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

import type { CustomRuleLocation } from './custom-rule.analyzer';
import { registryMethods } from './custom-rule-api.registry';

const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
const MAX_SOURCE_FILES = 200;
const MAX_SOURCE_BYTES = 1_000_000;

export const P0_RULE_IDS = {
  lifecycle: 'custom.lifecycle-entry',
  process: 'custom.process-execution',
  collection: 'custom.collection-source',
  credential: 'custom.credential-source',
  sensitiveFile: 'custom.sensitive-file-access',
  network: 'custom.network-outbound',
  download: 'custom.remote-download',
  fileWrite: 'custom.filesystem.write',
  formDataExfiltration: 'threat-network-form-data-exfiltration',
} as const;

export type P0RuleId = (typeof P0_RULE_IDS)[keyof typeof P0_RULE_IDS];

export interface P0Observation {
  key: string;
  ruleId: P0RuleId;
  message: string;
  locations: CustomRuleLocation[];
  data: {
    interpretation: 'STATIC_PATTERN';
    signalRuleIds: string[];
    doesNotProve: string;
    actionHint: string;
    sourceType?: string;
    sinkType?: string;
    executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE' | 'RUNTIME' | 'UNKNOWN';
    evidenceKind: 'STATIC_PATTERN';
    analysisLevel: 'PATTERN';
    limitations: string[];
    reviewStatus: 'PENDING';
    confidence: 'MEDIUM';
  };
}

export interface P0RelationDraft {
  relationType:
    | 'LIFECYCLE_TO_PROCESS'
    | 'COLLECTION_TO_NETWORK'
    | 'DOWNLOAD_TO_WRITE'
    | 'DOWNLOAD_TO_EXECUTE';
  sourceKeys: string[];
  sinkKeys: string[];
  evidenceKind: 'STATIC_DATA_FLOW' | 'STATIC_EXECUTION_PATH';
  analysisLevel: 'DATA_FLOW' | 'EXECUTION_PATH';
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE' | 'RUNTIME' | 'UNKNOWN';
  limitations: string[];
}

export interface P0StaticResult {
  observations: P0Observation[];
  relations: P0RelationDraft[];
}

interface SourceFile {
  path: string;
  absolutePath: string;
  content: string;
  lines: string[];
}

interface FileAnalysis {
  observations: P0Observation[];
  relations: P0RelationDraft[];
  imports: string[];
  processKeys: string[];
}

interface AliasRegistry {
  modules: Map<string, string>;
  methods: Map<string, { module: string; method: string }>;
}

interface TaintState {
  collection: Map<string, Set<string>>;
  download: Map<string, Set<string>>;
}

export async function analyzeP0StaticFlows(
  extractedPath: string,
  packageJsonValue: unknown,
): Promise<P0StaticResult> {
  const packageJson = asRecord(packageJsonValue);
  const files = await readSourceFiles(extractedPath);
  if (files.length === 0) return { observations: [], relations: [] };

  const analyses = new Map<string, FileAnalysis>();
  for (const file of files) analyses.set(file.path, analyzeFile(file));

  const observations = [...analyses.values()].flatMap((value) => value.observations);
  const relations = [...analyses.values()].flatMap((value) => value.relations);
  const lifecycle = lifecycleObservations(packageJson, files, analyses);
  observations.push(...lifecycle.observations);
  relations.push(...lifecycle.relations);

  return {
    observations: deduplicateObservations(observations),
    relations: deduplicateRelations(relations),
  };
}

async function readSourceFiles(root: string): Promise<SourceFile[]> {
  const discovered: string[] = [];
  try {
    await walk(root, discovered);
  } catch {
    return [];
  }

  const files: SourceFile[] = [];
  for (const absolutePath of discovered.sort().slice(0, MAX_SOURCE_FILES)) {
    try {
      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_SOURCE_BYTES) continue;
      const content = await readFile(absolutePath, 'utf8');
      files.push({
        path: relative(root, absolutePath).split('\\').join('/'),
        absolutePath,
        content,
        lines: content.split(/\r?\n/u),
      });
    } catch {
      // Unreadable files are outside the conservative static-analysis scope.
    }
  }
  return files;
}

async function walk(directory: string, output: string[]): Promise<void> {
  if (output.length >= MAX_SOURCE_FILES) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_SOURCE_FILES) return;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') await walk(path, output);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      output.push(path);
    }
  }
}

function analyzeFile(file: SourceFile): FileAnalysis {
  const aliases = collectAliases(file.content);
  const observations: P0Observation[] = [];
  const relations: P0RelationDraft[] = [];
  const taint: TaintState = { collection: new Map(), download: new Map() };
  const imports = collectLocalImports(file);
  const processKeys: string[] = [];
  const collectionKeysByLine = new Map<number, string[]>();
  const writes: Array<{ key: string; pathExpression: string; downloadSources: Set<string> }> = [];

  file.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const assignment = assignedIdentifier(line);
    const source = collectionSource(line);
    if (source !== undefined) {
      const ruleId = source.sensitiveFile
        ? P0_RULE_IDS.sensitiveFile
        : source.credential ? P0_RULE_IDS.credential : P0_RULE_IDS.collection;
      const observation = makeObservation(
        ruleId,
        file.path,
        lineNumber,
        source.sensitiveFile
          ? 'Sensitive file read pattern observed.'
          : source.credential ? 'Credential-like source access observed.' : 'Collection source access observed.',
        source.sensitiveFile ? 'SENSITIVE_FILE_READ' : source.credential ? 'CREDENTIAL_ACCESS' : 'COLLECTION_SOURCE',
        'RUNTIME',
        { sourceType: source.type },
      );
      observations.push(observation);
      collectionKeysByLine.set(lineNumber, [
        ...(collectionKeysByLine.get(lineNumber) ?? []),
        observation.key,
      ]);
      if (assignment !== undefined) addTaint(taint.collection, assignment, observation.key);
    }

    const download = downloadSource(line, aliases);
    if (download !== undefined) {
      const observation = makeObservation(
        P0_RULE_IDS.download,
        file.path,
        lineNumber,
        'Remote response or download candidate observed.',
        'REMOTE_DOWNLOAD',
        'RUNTIME',
        { sourceType: download.type },
      );
      observations.push(observation);
      if (assignment !== undefined) addTaint(taint.download, assignment, observation.key);
      if (download.callbackVariable !== undefined) {
        addTaint(taint.download, download.callbackVariable, observation.key);
      }
    }
  });

  propagateTaint(file.lines, taint.collection);
  propagateTaint(file.lines, taint.download);

  file.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const process = processSink(line, aliases);
    if (process !== undefined) {
      const observation = makeObservation(
        P0_RULE_IDS.process,
        file.path,
        lineNumber,
        'Process or shell execution API observed.',
        'PROCESS_EXECUTION',
        'RUNTIME',
        { sinkType: process.type },
      );
      observations.push(observation);
      processKeys.push(observation.key);
    }

    const network = networkSink(line, aliases);
    if (network !== undefined) {
      const observation = makeObservation(
        P0_RULE_IDS.network,
        file.path,
        lineNumber,
        'Network egress API observed.',
        'NETWORK_REQUEST',
        'RUNTIME',
        { sinkType: network.type },
      );
      observations.push(observation);
      const sources = taintSourcesInExpression(network.payloadExpression, taint.collection);
      if (collectionSource(network.payloadExpression) !== undefined) {
        for (const key of collectionKeysByLine.get(lineNumber) ?? []) sources.add(key);
      }
      if (network.type.startsWith('jquery.')) {
        for (const key of collectionKeysInNetworkCall(file.lines, index, collectionKeysByLine)) {
          sources.add(key);
        }
      }
      if (sources.size > 0) {
        relations.push({
          relationType: 'COLLECTION_TO_NETWORK',
          sourceKeys: [...sources].sort(),
          sinkKeys: [observation.key],
          evidenceKind: 'STATIC_DATA_FLOW',
          analysisLevel: 'DATA_FLOW',
          executionContext: 'RUNTIME',
          limitations: [
            'Static identifier flow does not prove that a remote server received or processed the value.',
            'Flow through dynamic properties, closures, or external modules may not be represented.',
          ],
        });
      }

      if (network.type === 'jquery.ajax'
        && isExternalSerializedFormSubmission(file.lines, index, collectionKeysByLine)) {
        observations.push(makeObservation(
          P0_RULE_IDS.formDataExfiltration,
          file.path,
          lineNumber,
          'Serialized form data is sent to an external HTTP endpoint.',
          'FORM_DATA_EXFILTRATION',
          'RUNTIME',
          { sourceType: 'SERIALIZED_FORM_DATA', sinkType: 'EXTERNAL_HTTP_ENDPOINT' },
        ));
      }
    }

    const write = fileWriteSink(line, aliases);
    if (write !== undefined) {
      const observation = makeObservation(
        P0_RULE_IDS.fileWrite,
        file.path,
        lineNumber,
        'Filesystem write API observed.',
        'FILE_WRITE',
        'RUNTIME',
        { sinkType: write.type },
      );
      observations.push(observation);
      const downloadSources = taintSourcesInExpression(write.dataExpression, taint.download);
      writes.push({ key: observation.key, pathExpression: write.pathExpression, downloadSources });
      if (downloadSources.size > 0) {
        relations.push({
          relationType: 'DOWNLOAD_TO_WRITE',
          sourceKeys: [...downloadSources].sort(),
          sinkKeys: [observation.key],
          evidenceKind: 'STATIC_DATA_FLOW',
          analysisLevel: 'DATA_FLOW',
          executionContext: 'RUNTIME',
          limitations: ['Static flow does not prove that bytes were downloaded or written successfully.'],
        });
      }
    }

    if (process !== undefined) {
      const matchingWrites = writes.filter(
        (write) => write.downloadSources.size > 0 && expressionsOverlap(write.pathExpression, process.argumentExpression),
      );
      for (const write of matchingWrites) {
        relations.push({
          relationType: 'DOWNLOAD_TO_EXECUTE',
          sourceKeys: [...write.downloadSources].sort(),
          sinkKeys: [processKeys[processKeys.length - 1] as string],
          evidenceKind: 'STATIC_EXECUTION_PATH',
          analysisLevel: 'EXECUTION_PATH',
          executionContext: 'RUNTIME',
          limitations: [
            'Static path linkage does not prove that the downloaded file was created or executed successfully.',
            `Intermediate write candidate ${write.key} is preserved as separate Atomic Finding.`,
          ],
        });
      }
    }
  });

  addPipeRelations(file, observations, relations, taint.download);
  return { observations: deduplicateObservations(observations), relations, imports, processKeys };
}

function lifecycleObservations(
  packageJson: Record<string, unknown> | undefined,
  files: SourceFile[],
  analyses: Map<string, FileAnalysis>,
): P0StaticResult {
  const scripts = asRecord(packageJson?.scripts);
  if (scripts === undefined) return { observations: [], relations: [] };
  const observations: P0Observation[] = [];
  const relations: P0RelationDraft[] = [];

  for (const name of ['preinstall', 'install', 'postinstall', 'prepare'] as const) {
    const command = scripts[name];
    if (typeof command !== 'string') continue;
    const context = lifecycleContext(name);
    const commandAnalysis = analyzeLifecycleCommand(command, name, context);
    observations.push(...commandAnalysis.observations);
    relations.push(...commandAnalysis.relations);
    const entry = lifecycleEntry(command, files);
    if (entry === undefined) {
      if (!/(?:^|\s)(?:sh|bash|powershell|pwsh|cmd)(?:\s|$)|\|\s*(?:sh|bash)(?:\s|$)|\bnode\s+-e\b/iu.test(command)) continue;
      if (commandAnalysis.observations.length > 0) continue;
      const lifecycle = makeMetadataObservation(name, context);
      const process = makeMetadataProcessObservation(name, context);
      observations.push(lifecycle, process);
      relations.push({
        relationType: 'LIFECYCLE_TO_PROCESS',
        sourceKeys: [lifecycle.key],
        sinkKeys: [process.key],
        evidenceKind: 'STATIC_EXECUTION_PATH',
        analysisLevel: 'EXECUTION_PATH',
        executionContext: context,
        limitations: ['The lifecycle shell declaration does not prove successful command execution.'],
      });
      continue;
    }
    const lifecycle = makeMetadataObservation(name, context);
    observations.push(lifecycle);
    const reachable = reachableFiles(entry, analyses, files);
    for (const path of reachable) {
      const analysis = analyses.get(path);
      if (analysis === undefined) continue;
      for (const processKey of analysis.processKeys) {
        const processObservation = analysis.observations.find(({ key }) => key === processKey);
        if (processObservation !== undefined) processObservation.data.executionContext = context;
        relations.push({
          relationType: 'LIFECYCLE_TO_PROCESS',
          sourceKeys: [lifecycle.key],
          sinkKeys: [processKey],
          evidenceKind: 'STATIC_EXECUTION_PATH',
          analysisLevel: 'EXECUTION_PATH',
          executionContext: context,
          limitations: [
            'The lifecycle declaration and local import path are static candidates; runtime execution was not verified.',
          ],
        });
      }
    }
  }
  return { observations, relations };
}

interface LifecycleCommandAnalysis {
  observations: P0Observation[];
  relations: P0RelationDraft[];
}

interface LifecycleCommandSignals {
  hasDownload: boolean;
  hasNetwork: boolean;
  hasFileWrite: boolean;
  hasProcess: boolean;
  hasExecutedFile: boolean;
  hasChain: boolean;
}

/**
 * Analyzes only the command text of preinstall/postinstall. The command is
 * never passed to a shell; this is intentionally a bounded lexical scan that
 * reuses the existing P0 Finding and relation vocabulary.
 */
function analyzeLifecycleCommand(
  command: string,
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE',
): LifecycleCommandAnalysis {
  const signals = lifecycleCommandSignals(command);
  const source = collectionSource(command, true);
  if (!signals.hasDownload && !signals.hasNetwork && !signals.hasFileWrite && !signals.hasProcess && source === undefined) {
    return { observations: [], relations: [] };
  }

  const observations: P0Observation[] = [];
  const relations: P0RelationDraft[] = [];
  const download = signals.hasDownload
    ? makeMetadataCommandObservation(
      P0_RULE_IDS.download,
      script,
      executionContext,
      'Remote download command is statically present in the lifecycle script.',
      'REMOTE_DOWNLOAD',
      'REMOTE_COMMAND',
    )
    : undefined;
  const network = signals.hasNetwork
    ? makeMetadataCommandObservation(
      P0_RULE_IDS.network,
      script,
      executionContext,
      'Network command is statically present in the lifecycle script.',
      'NETWORK_REQUEST',
      'NETWORK_COMMAND',
    )
    : undefined;
  const fileWrite = signals.hasFileWrite
    ? makeMetadataCommandObservation(
      P0_RULE_IDS.fileWrite,
      script,
      executionContext,
      'A shell redirection or output file is statically present in the lifecycle script.',
      'FILE_WRITE',
      'SHELL_FILE_WRITE',
    )
    : undefined;
  const process = signals.hasProcess
    ? makeMetadataCommandObservation(
      P0_RULE_IDS.process,
      script,
      executionContext,
      'A shell, inline runtime, or chained executable command is statically present in the lifecycle script.',
      'PROCESS_EXECUTION',
      'LIFECYCLE_COMMAND',
    )
    : undefined;
  const sourceObservation = source === undefined
    ? undefined
    : makeMetadataSourceObservation(source, script, executionContext);

  for (const observation of [download, network, fileWrite, process, sourceObservation]) {
    if (observation !== undefined) observations.push(observation);
  }

  if (download !== undefined && fileWrite !== undefined) {
    relations.push({
      relationType: 'DOWNLOAD_TO_WRITE',
      sourceKeys: [download.key],
      sinkKeys: [fileWrite.key],
      evidenceKind: 'STATIC_DATA_FLOW',
      analysisLevel: 'DATA_FLOW',
      executionContext,
      limitations: [
        'Static lifecycle command text does not prove that bytes were downloaded or written successfully.',
      ],
    });
  }
  if (download !== undefined && process !== undefined && signals.hasExecutedFile) {
    relations.push({
      relationType: 'DOWNLOAD_TO_EXECUTE',
      sourceKeys: [download.key],
      sinkKeys: [process.key],
      evidenceKind: 'STATIC_EXECUTION_PATH',
      analysisLevel: 'EXECUTION_PATH',
      executionContext,
      limitations: [
        'Static lifecycle command text does not prove that a downloaded file was created or executed successfully.',
      ],
    });
  }

  return { observations, relations };
}

function lifecycleCommandSignals(command: string): LifecycleCommandSignals {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/u).filter((segment) => segment.trim() !== '');
  const hasChain = segments.length > 1;
  const hasShellInterpreter = /(?:^|[\s;&|])(?:sh|bash|dash|zsh|ksh|fish|powershell|pwsh|cmd(?:\.exe)?)(?:\s+(?:-c|\/c|-command|-encodedcommand)\b|\s|$)/iu.test(command);
  const hasInlineRuntime = /\b(?:node(?:js)?|python(?:3)?|ruby|perl)\s+(?:-e|--eval|-p|--print|-c)\b/iu.test(command);
  const hasInlineNode = /\bnode(?:js)?\s+(?:-e|--eval|-p|--print)\b/iu.test(command);
  const hasInlineProcess = /\b(?:child_process\.(?:exec|execFile|spawn|spawnSync|fork)|require\(\s*['"](?:node:)?child_process['"]\s*\)|(?:exec|execFile|spawn|spawnSync|fork)\s*\()/iu.test(command);
  const hasInlineRemoteFetch = hasInlineRuntime && /\b(?:fetch|axios\.(?:get|request|post|put|patch)|https?\.(?:get|request)|urllib(?:\.request\.)?(?:urlopen|Request)|requests?\.(?:get|post|request)|httpx\.(?:get|post|request))\s*\([^)]*https?:\/\//iu.test(command);
  const hasNpmRemoteFetch = /\b(?:npx|npm\s+(?:exec|install))\b[^;&|]*https?:\/\//iu.test(command);
  const hasDownload = /\b(?:curl|wget)\b[^;&|]*(?:https?:\/\/|ftp:\/\/)|\b(?:invoke-webrequest|invoke-restmethod|iwr|irm|bitsadmin|certutil)\b[^;&|]*https?:\/\//iu.test(command)
    || hasInlineRemoteFetch || hasNpmRemoteFetch;
  const hasNetwork = hasDownload
    || (hasInlineRuntime && /\b(?:fetch|axios\.(?:get|request|post|put|patch)|https?\.(?:get|request)|urllib(?:\.request\.)?(?:urlopen|Request)|requests?\.(?:get|post|request)|httpx\.(?:get|post|request))\s*\(/iu.test(command));
  const hasFileWrite = /\b(?:curl|wget)\b[^;&|]*\s(?:-o|-O|--output|--output-document)(?:=|\s+)[^;&|\s]+/iu.test(command)
    || /(?:^|[\s;&|])[^;&|]+\s+>{1,2}\s*[^\s;&|]+/u.test(command)
    || /\b(?:tee|out-file|set-content|add-content)\b(?:\s+-a)?\s+[^\s;&|]+/iu.test(command)
    || (hasInlineNode && /\b(?:writeFileSync|writeFile|createWriteStream)\s*\(/u.test(command));
  const hasChmodExecutable = /\bchmod\s+(?:[^;&|\s]*\+[^;&|\s]*x|[0-7]*[1-7][0-7]{2})\s+[^;&|]+/iu.test(command);
  const hasExplicitExecutable = segments.some((segment) =>
    /^\s*(?:node(?:js)?|(?:sh|bash|dash|zsh|ksh|fish|powershell|pwsh|cmd(?:\.exe)?|python(?:3)?|ruby|perl)\b|(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]))/iu.test(segment),
  );
  const hasDirectShellScript = segments.some((segment) =>
    /^\s*(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])[^;&|\s]+\.(?:sh|bash|ps1|cmd|bat)\b/iu.test(segment),
  );
  const hasExecutedFile = (hasDownload || hasFileWrite || hasChmodExecutable) && hasChain && hasExplicitExecutable;
  const hasProcess = hasShellInterpreter || hasInlineRuntime || hasInlineProcess || hasExecutedFile || hasDirectShellScript || hasChmodExecutable;

  return { hasDownload, hasNetwork, hasFileWrite, hasProcess, hasExecutedFile, hasChain };
}

function lifecycleContext(
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
): 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE' {
  return script === 'preinstall'
    ? 'PREINSTALL'
    : script === 'install'
      ? 'INSTALL'
      : script === 'postinstall'
        ? 'POSTINSTALL'
        : 'PREPARE';
}

function collectAliases(content: string): AliasRegistry {
  const modules = new Map<string, string>();
  const methods = new Map<string, { module: string; method: string }>();
  for (const match of content.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    modules.set(match[1] as string, match[2] as string);
  }
  for (const match of content.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    const module = match[2] as string;
    for (const part of (match[1] as string).split(',')) {
      const [methodValue, aliasValue] = part.trim().split(/\s*:\s*/u);
      const method = methodValue?.trim();
      const alias = (aliasValue ?? methodValue)?.trim();
      if (method && alias) methods.set(alias, { module, method });
    }
  }
  for (const match of content.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/gu)) {
    modules.set(match[1] as string, match[2] as string);
  }
  for (const match of content.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gu)) {
    const module = match[2] as string;
    for (const part of (match[1] as string).split(',')) {
      const [methodValue, aliasValue] = part.trim().split(/\s+as\s+/u);
      const method = methodValue?.trim();
      const alias = (aliasValue ?? methodValue)?.trim();
      if (method && alias) methods.set(alias, { module, method });
    }
  }
  return { modules, methods };
}

function collectionSource(
  line: string,
  allowShellEnvironment = false,
): { credential: boolean; sensitiveFile?: boolean; type: string } | undefined {
  if (/(?:readFile|readFileSync)\s*\([^\n]*(?:\.npmrc|\.ssh[\\/]|\.aws[\\/]|\.azure[\\/]|gcloud|id_rsa|id_ed25519|(?:^|[\\/])credentials(?:[\\/]|$))/iu.test(line)
    || /\b(?:cat|type|more|head|tail|get-content|gc)\b[^\n]*(?:\.npmrc|\.ssh[\\/]|\.aws[\\/]|\.azure[\\/]|gcloud|id_rsa|id_ed25519|credentials)/iu.test(line)) {
    return { credential: false, sensitiveFile: true, type: 'SENSITIVE_FILE' };
  }
  const environment = line.match(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])/u)
    ?? (allowShellEnvironment ? line.match(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/u) : null)
    ?? (allowShellEnvironment ? line.match(/\b(?:printenv|env)\s+([A-Za-z_][A-Za-z0-9_]*)/iu) : null);
  if (environment !== null) {
    const name = environment[1] ?? environment[2] ?? environment[3] ?? environment[4] ?? '';
    const credential = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|AUTH|CREDENTIAL|NPM_CONFIG|AWS_|AZURE_|GCP_|GITHUB_|REGISTRY)/iu.test(name);
    return { credential, type: credential ? 'CREDENTIAL_ENVIRONMENT' : 'ENVIRONMENT_VARIABLE' };
  }
  if (/(?:os\.)?(?:hostname|type|release|platform|arch)\s*\(|process\.cwd\s*\(/u.test(line)) {
    return { credential: false, type: 'SYSTEM_INFORMATION' };
  }
  if (/(?:clipboard\.)?(?:readText|read)\s*\(|\.on\s*\(\s*['"](?:keydown|keypress|keyboard)['"]/u.test(line)) {
    return { credential: false, type: 'USER_INPUT' };
  }
  if (/\.serialize(?:Array)?\s*\(/u.test(line) || /\bnew\s+FormData\s*\(/u.test(line)) {
    return { credential: false, type: 'SERIALIZED_FORM_DATA' };
  }
  return undefined;
}

function processSink(line: string, aliases: AliasRegistry): { type: string; argumentExpression: string } | undefined {
  const direct = line.match(/(?:child_process|childProcess)\.(execFile|exec|spawnSync|spawn|fork)\s*\((.*)/u);
  if (direct !== null) return { type: direct[1] as string, argumentExpression: direct[2] as string };
  for (const [alias, module] of aliases.modules) {
    if (module !== 'child_process' && module !== 'node:child_process') continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\.(execFile|exec|spawnSync|spawn|fork)\\s*\\((.*)`, 'u'));
    if (match !== null) return { type: match[1] as string, argumentExpression: match[2] as string };
  }
  for (const [alias, value] of aliases.methods) {
    if (value.module !== 'child_process' && value.module !== 'node:child_process') continue;
    if (!['exec', 'execFile', 'spawn', 'spawnSync', 'fork'].includes(value.method)) continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\s*\\((.*)`, 'u'));
    if (match !== null) return { type: value.method, argumentExpression: match[1] as string };
  }
  return undefined;
}

function networkSink(line: string, aliases: AliasRegistry): { type: string; payloadExpression: string } | undefined {
  const jquery = line.match(/(?:^|[^\w$])(?:\$|jQuery)\.(ajax|post|put|patch|get)\s*\((.*)/u);
  if (jquery !== null) {
    return { type: `jquery.${jquery[1] as string}`, payloadExpression: jquery[2] as string };
  }
  const direct = line.match(/\b(fetch|request)\s*\((.*)|\b(?:http|https|net)\.(?:request|get|connect)\s*\((.*)|\baxios\.(?:request|post|put|patch|get)\s*\((.*)/u);
  if (direct !== null) {
    const type = direct[1] ?? (direct[2] === undefined ? 'network-call' : 'http-request');
    return { type, payloadExpression: direct.slice(2).find((value) => value !== undefined) ?? '' };
  }
  for (const [alias, module] of aliases.modules) {
    const registry = registryMethods(module, 'NETWORK');
    const methods = registry.length > 0
      ? `(?:${registry.map(escapeRegex).join('|')})`
      : ['http', 'https', 'node:http', 'node:https'].includes(module) ? '(?:request|get)'
        : ['net', 'node:net'].includes(module) ? '(?:connect)' : undefined;
    if (methods === undefined) continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\.${methods}\\s*\\((.*)`, 'u'));
    if (match !== null) return { type: module, payloadExpression: match[1] as string };
  }
  for (const [alias, value] of aliases.methods) {
    if (!['http', 'https', 'node:http', 'node:https', 'axios', 'request'].includes(value.module)) continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\s*\\((.*)`, 'u'));
    if (match !== null) return { type: `${value.module}.${value.method}`, payloadExpression: match[1] as string };
  }
  return undefined;
}

function collectionKeysInNetworkCall(
  lines: readonly string[],
  startLineIndex: number,
  collectionKeysByLine: ReadonlyMap<number, readonly string[]>,
): Set<string> {
  const keys = new Set<string>();
  const endLineIndex = findCallEndLine(lines, startLineIndex);
  for (let index = startLineIndex; index <= endLineIndex; index += 1) {
    for (const key of collectionKeysByLine.get(index + 1) ?? []) keys.add(key);
  }
  return keys;
}

function isExternalSerializedFormSubmission(
  lines: readonly string[],
  startLineIndex: number,
  collectionKeysByLine: ReadonlyMap<number, readonly string[]>,
): boolean {
  const endLineIndex = findCallEndLine(lines, startLineIndex);
  const callText = lines.slice(startLineIndex, endLineIndex + 1).join('\n');
  const hasSerializedFormData = [...Array.from({ length: endLineIndex - startLineIndex + 1 }, (_, offset) => startLineIndex + offset)]
    .some((index) => (collectionKeysByLine.get(index + 1)?.length ?? 0) > 0);
  return hasSerializedFormData
    && /\burl\s*:\s*['"]https?:\/\/[^'"]+['"]/iu.test(callText);
}

function findCallEndLine(lines: readonly string[], startLineIndex: number): number {
  let depth = 0;
  let started = false;
  for (let index = startLineIndex; index < lines.length; index += 1) {
    for (const character of lines[index] as string) {
      if (character === '{' || character === '(' || character === '[') {
        depth += 1;
        started = true;
      } else if (character === '}' || character === ')' || character === ']') {
        depth -= 1;
      }
    }
    if (started && depth <= 0) return index;
  }
  return lines.length - 1;
}

function downloadSource(line: string, aliases: AliasRegistry): { type: string; callbackVariable?: string } | undefined {
  const assigned = /(?:=\s*(?:await\s+)?(?:fetch|axios\.(?:get|request)|(?:http|https)\.(?:get|request))\s*\()|(?:http|https)\.(?:get|request)\s*\([^,]+,\s*(?:\(|)([A-Za-z_$][\w$]*)/u.exec(line);
  if (assigned !== null) return { type: 'REMOTE_RESPONSE', callbackVariable: assigned[1] };
  for (const [alias, module] of aliases.modules) {
    const registry = registryMethods(module, 'DOWNLOAD');
    if (registry.length === 0 && !['http', 'https', 'node:http', 'node:https'].includes(module)) continue;
    const methods = registry.length > 0 ? registry.map(escapeRegex).join('|') : 'get|request';
    const callback = line.match(new RegExp(`\\b${escapeRegex(alias)}\\.(?:${methods})\\s*\\([^,]+,\\s*\\(?([A-Za-z_$][\\w$]*)`, 'u'));
    if (callback !== null) {
      return { type: 'REMOTE_RESPONSE', callbackVariable: callback[1] as string };
    }
    if (new RegExp(`=\\s*(?:await\\s+)?${escapeRegex(alias)}\\.(?:${methods})\\s*\\(`, 'u').test(line)) {
      return { type: 'REMOTE_RESPONSE' };
    }
  }
  return undefined;
}

function fileWriteSink(line: string, aliases: AliasRegistry): { type: string; pathExpression: string; dataExpression: string } | undefined {
  const direct = line.match(/(?:fs\.)?(writeFileSync|writeFile)\s*\(([^,]+),\s*([^,)]+)/u);
  if (direct !== null) return { type: direct[1] as string, pathExpression: direct[2] as string, dataExpression: direct[3] as string };
  const stream = line.match(/(?:fs\.)?createWriteStream\s*\(([^,)]+)/u);
  if (stream !== null) return { type: 'createWriteStream', pathExpression: stream[1] as string, dataExpression: '' };
  for (const [alias, module] of aliases.modules) {
    if (!['fs', 'node:fs'].includes(module)) continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\.(writeFileSync|writeFile)\\s*\\(([^,]+),\\s*([^,)]*)`, 'u'));
    if (match !== null) {
      return { type: match[1] as string, pathExpression: match[2] as string, dataExpression: match[3] as string };
    }
    const streamMatch = line.match(new RegExp(`\\b${escapeRegex(alias)}\\.createWriteStream\\s*\\(([^,)]*)`, 'u'));
    if (streamMatch !== null) {
      return { type: 'createWriteStream', pathExpression: streamMatch[1] as string, dataExpression: '' };
    }
  }
  for (const [alias, value] of aliases.methods) {
    if (!['fs', 'node:fs'].includes(value.module) || !['writeFile', 'writeFileSync', 'createWriteStream'].includes(value.method)) continue;
    const match = line.match(new RegExp(`\\b${escapeRegex(alias)}\\s*\\(([^,]+)(?:,\\s*([^,)]*))?`, 'u'));
    if (match !== null) return { type: value.method, pathExpression: match[1] as string, dataExpression: match[2] ?? '' };
  }
  return undefined;
}

function propagateTaint(lines: string[], taint: Map<string, Set<string>>): void {
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const line of lines) {
      const left = assignedIdentifier(line);
      if (left === undefined) continue;
      const right = line.slice(line.indexOf('=') + 1);
      const sources = taintSourcesInExpression(right, taint);
      if (sources.size > 0) changed = addTaintSet(taint, left, sources) || changed;
    }
    changed = propagateFunctionArguments(lines, taint) || changed;
    if (!changed) return;
  }
}

function propagateFunctionArguments(lines: string[], taint: Map<string, Set<string>>): boolean {
  const functions = new Map<string, string[]>();
  for (const line of lines) {
    const declaration = line.match(/function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/u);
    if (declaration === null) continue;
    const name = declaration[1] ?? declaration[3];
    const parameters = declaration[2] ?? declaration[4] ?? '';
    if (name !== undefined) {
      functions.set(name, parameters.split(',').map((value) => value.trim()).filter(Boolean));
    }
  }

  let changed = false;
  for (const [name, parameters] of functions) {
    for (const line of lines) {
      if (/\bfunction\s+/u.test(line) || new RegExp(`\\b${escapeRegex(name)}\\s*=`, 'u').test(line)) continue;
      const call = line.match(new RegExp(`\\b${escapeRegex(name)}\\s*\\(([^)]*)\\)`, 'u'));
      if (call === null) continue;
      const argumentsList = (call[1] ?? '').split(',');
      parameters.forEach((parameter, index) => {
        const argument = argumentsList[index];
        if (argument === undefined) return;
        const sources = taintSourcesInExpression(argument, taint);
        if (sources.size > 0) changed = addTaintSet(taint, parameter, sources) || changed;
      });
    }
  }
  return changed;
}

function assignedIdentifier(line: string): string | undefined {
  const match = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=|\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*=/u);
  return match?.[1] ?? match?.[2];
}

function taintSourcesInExpression(expression: string, taint: Map<string, Set<string>>): Set<string> {
  const sources = new Set<string>();
  for (const [identifier, keys] of taint) {
    const root = identifier.split('.')[0] as string;
    if (new RegExp(`\\b${escapeRegex(root)}\\b`, 'u').test(expression)) {
      for (const key of keys) sources.add(key);
    }
  }
  return sources;
}

function addTaint(taint: Map<string, Set<string>>, identifier: string, key: string): void {
  addTaintSet(taint, identifier, new Set([key]));
}

function addTaintSet(taint: Map<string, Set<string>>, identifier: string, keys: Set<string>): boolean {
  const current = taint.get(identifier) ?? new Set<string>();
  const size = current.size;
  for (const key of keys) current.add(key);
  taint.set(identifier, current);
  const root = identifier.split('.')[0];
  if (root !== undefined && root !== identifier) taint.set(root, new Set(current));
  return current.size !== size;
}

function collectLocalImports(file: SourceFile): string[] {
  const imports = new Set<string>();
  for (const match of file.content.matchAll(/(?:require\(\s*|from\s+|import\(\s*)['"](\.[^'"]+)['"]/gu)) {
    const resolved = resolveLocalImport(file, match[1] as string);
    if (resolved !== undefined) imports.add(resolved);
  }
  return [...imports].sort();
}

function resolveLocalImport(file: SourceFile, request: string): string | undefined {
  const absolute = normalize(resolve(dirname(file.absolutePath), request));
  const root = resolve(file.absolutePath, ...file.path.split('/').map(() => '..'));
  const candidate = relative(root, absolute).split('\\').join('/');
  return candidate.startsWith('../') ? undefined : candidate;
}

function lifecycleEntry(command: string, files: SourceFile[]): string | undefined {
  const match = command.match(/(?:^|\s)(?:node\s+)?(?:\.\/)?([^\s;&|]+\.(?:js|cjs|mjs|ts))(?:\s|$)/u);
  if (match === null) return undefined;
  const requested = normalize(match[1] as string).split('\\').join('/').replace(/^\.\//u, '');
  return files.find(({ path }) => path === requested || path.endsWith(`/${requested}`))?.path;
}

function reachableFiles(entry: string, analyses: Map<string, FileAnalysis>, files: SourceFile[]): Set<string> {
  const reachable = new Set<string>();
  const queue = [entry];
  while (queue.length > 0 && reachable.size < 50) {
    const current = queue.shift() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const request of analyses.get(current)?.imports ?? []) {
      const resolved = resolveImportedPath(request, files);
      if (resolved !== undefined && !reachable.has(resolved)) queue.push(resolved);
    }
  }
  return reachable;
}

function resolveImportedPath(request: string, files: SourceFile[]): string | undefined {
  const options = [request, `${request}.js`, `${request}.cjs`, `${request}.mjs`, `${request}.ts`, `${request}/index.js`];
  return files.find(({ path }) => options.includes(path))?.path;
}

function makeObservation(
  ruleId: P0RuleId,
  path: string,
  line: number,
  message: string,
  actionHint: string,
  executionContext: P0Observation['data']['executionContext'],
  detail: { sourceType?: string; sinkType?: string },
): P0Observation {
  const key = `${ruleId}:${path}:${line}:${actionHint}`;
  return {
    key,
    ruleId,
    message,
    locations: [{ type: 'SOURCE_FILE', path, startLine: line }],
    data: {
      interpretation: 'STATIC_PATTERN',
      signalRuleIds: [ruleId],
      doesNotProve: 'Static evidence does not prove runtime execution or external reception.',
      actionHint,
      ...detail,
      executionContext,
      evidenceKind: 'STATIC_PATTERN',
      analysisLevel: 'PATTERN',
      limitations: ['Limited lexical flow and direct local-module analysis only.'],
      reviewStatus: 'PENDING',
      confidence: 'MEDIUM',
    },
  };
}

function makeMetadataObservation(
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE',
): P0Observation {
  const ruleId = P0_RULE_IDS.lifecycle;
  return {
    key: `${ruleId}:package.json:/scripts/${script}`,
    ruleId,
    message: `${script} lifecycle script references a local source entry.`,
    locations: [{ type: 'METADATA', jsonPointer: `/scripts/${script}` }],
    data: {
      interpretation: 'STATIC_PATTERN',
      signalRuleIds: [ruleId],
      doesNotProve: 'Lifecycle declaration does not prove runtime execution.',
      actionHint: 'LIFECYCLE_ENTRY',
      executionContext,
      evidenceKind: 'STATIC_PATTERN',
      analysisLevel: 'PATTERN',
      limitations: ['Only explicit local JavaScript or TypeScript entry paths are followed.'],
      reviewStatus: 'PENDING',
      confidence: 'MEDIUM',
    },
  };
}

function makeMetadataProcessObservation(
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE',
): P0Observation {
  const base = makeMetadataObservation(script, executionContext);
  return {
    ...base,
    key: `${P0_RULE_IDS.process}:package.json:/scripts/${script}`,
    ruleId: P0_RULE_IDS.process,
    message: `${script} lifecycle script contains an explicit shell interpreter or inline command.`,
    data: {
      ...base.data,
      actionHint: 'SHELL_COMMAND_EXECUTION',
      sinkType: 'LIFECYCLE_SHELL',
      limitations: ['Static lifecycle command text does not prove successful shell execution.'],
    },
  };
}

function makeMetadataCommandObservation(
  ruleId: P0RuleId,
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE',
  message: string,
  actionHint: string,
  sinkType: string,
  sourceType?: string,
): P0Observation {
  return {
    key: `${ruleId}:package.json:/scripts/${script}:${actionHint}`,
    ruleId,
    message,
    locations: [{ type: 'METADATA', jsonPointer: `/scripts/${script}` }],
    data: {
      interpretation: 'STATIC_PATTERN',
      signalRuleIds: [ruleId],
      doesNotProve: 'Static lifecycle command text does not prove successful runtime execution or external communication.',
      actionHint,
      sinkType,
      ...(sourceType === undefined ? {} : { sourceType }),
      executionContext,
      evidenceKind: 'STATIC_PATTERN',
      analysisLevel: 'PATTERN',
      limitations: [
        'Only bounded lexical patterns in lifecycle command text are analyzed; the command is never executed.',
      ],
      reviewStatus: 'PENDING',
      confidence: 'MEDIUM',
    },
  };
}

function makeMetadataSourceObservation(
  source: { credential: boolean; sensitiveFile?: boolean; type: string },
  script: 'preinstall' | 'install' | 'postinstall' | 'prepare',
  executionContext: 'PREINSTALL' | 'INSTALL' | 'POSTINSTALL' | 'PREPARE',
): P0Observation {
  const ruleId = source.sensitiveFile
    ? P0_RULE_IDS.sensitiveFile
    : source.credential ? P0_RULE_IDS.credential : P0_RULE_IDS.collection;
  const actionHint = source.sensitiveFile
    ? 'SENSITIVE_FILE_READ'
    : source.credential ? 'CREDENTIAL_ACCESS' : 'COLLECTION_SOURCE';
  const message = source.sensitiveFile
    ? 'Sensitive file read pattern is statically present in the lifecycle command.'
    : source.credential
      ? 'Credential-like source access is statically present in the lifecycle command.'
      : 'Collection source access is statically present in the lifecycle command.';
  return makeMetadataCommandObservation(
    ruleId,
    script,
    executionContext,
    message,
    actionHint,
    'LIFECYCLE_SOURCE',
    source.type,
  );
}

function addPipeRelations(
  file: SourceFile,
  observations: P0Observation[],
  relations: P0RelationDraft[],
  downloadTaint: Map<string, Set<string>>,
): void {
  file.lines.forEach((line, index) => {
    const match = line.match(/([A-Za-z_$][\w$]*)\.pipe\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/u);
    if (match === null) return;
    const sources = downloadTaint.get(match[1] as string);
    if (sources === undefined || sources.size === 0) return;
    const write = makeObservation(
      P0_RULE_IDS.fileWrite,
      file.path,
      index + 1,
      'Downloaded stream is piped to a write stream candidate.',
      'STREAM_FILE_WRITE',
      'RUNTIME',
      { sinkType: 'stream.pipe' },
    );
    observations.push(write);
    relations.push({
      relationType: 'DOWNLOAD_TO_WRITE',
      sourceKeys: [...sources].sort(),
      sinkKeys: [write.key],
      evidenceKind: 'STATIC_DATA_FLOW',
      analysisLevel: 'DATA_FLOW',
      executionContext: 'RUNTIME',
      limitations: ['Static stream linkage does not prove successful network or filesystem I/O.'],
    });
  });
}

function expressionsOverlap(left: string, right: string): boolean {
  const identifiers = left.match(/[A-Za-z_$][\w$]*/gu) ?? [];
  return identifiers.some((identifier) => new RegExp(`\\b${escapeRegex(identifier)}\\b`, 'u').test(right));
}

function deduplicateObservations(values: P0Observation[]): P0Observation[] {
  return [...new Map(values.map((value) => [value.key, value])).values()]
    .sort((left, right) => left.key.localeCompare(right.key));
}

function deduplicateRelations(values: P0RelationDraft[]): P0RelationDraft[] {
  const keyed = new Map<string, P0RelationDraft>();
  for (const value of values) {
    const normalized = {
      ...value,
      sourceKeys: [...new Set(value.sourceKeys)].sort(),
      sinkKeys: [...new Set(value.sinkKeys)].sort(),
    };
    const key = `${value.relationType}:${normalized.sourceKeys.join(',')}:${normalized.sinkKeys.join(',')}`;
    keyed.set(key, normalized);
  }
  return [...keyed.values()].sort((left, right) =>
    `${left.relationType}:${left.sourceKeys.join(',')}:${left.sinkKeys.join(',')}`.localeCompare(
      `${right.relationType}:${right.sourceKeys.join(',')}:${right.sinkKeys.join(',')}`,
    ));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
