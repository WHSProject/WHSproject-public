import type { BehaviorGroup } from '../context-check.contract';

export type ApiFamily =
  | 'NETWORK'
  | 'PROCESS'
  | 'FILE_READ'
  | 'FILE_MUTATION'
  | 'ARCHIVE'
  | 'DYNAMIC_CODE'
  | 'SYSTEM'
  | 'CREDENTIAL'
  | 'SURVEILLANCE'
  | 'PERSISTENCE'
  | 'PUBLISH';

/** `callable`: the module's own export is called. `members`: exact static dotted paths under it; `()` is an instance made with `new`. */
export interface ActionApi { callable?: boolean; members?: readonly string[] | '*' }
export interface ActionFactoryApi { instance: ActionApi }

/**
 * Built-ins are intentionally member-specific. A module origin alone is not an
 * operation: for example `fs.readFile` is a read, while `fs.existsSync` is not.
 */
export const BUILTIN_ACTION_APIS: Record<ApiFamily, Record<string, ActionApi>> = {
  NETWORK: {
    http: { members: ['request', 'get'] }, https: { members: ['request', 'get'] }, http2: { members: ['connect'] },
    net: { members: ['connect', 'createConnection'] }, tls: { members: ['connect'] },
    dns: { members: ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'] },
  },
  PROCESS: {
    child_process: { members: ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'] },
    worker_threads: { members: ['Worker'] },
  },
  FILE_READ: {
    fs: { members: ['read', 'readSync', 'readFile', 'readFileSync', 'readv', 'readvSync', 'createReadStream', 'open', 'openSync', 'opendir', 'opendirSync', 'readdir', 'readdirSync'] },
    'fs/promises': { members: ['readFile', 'open', 'opendir', 'readdir'] },
  },
  FILE_MUTATION: {
    fs: { members: [
      'write', 'writeSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'writev', 'writevSync', 'createWriteStream',
      'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
      'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync',
      'chmod', 'chmodSync', 'chown', 'chownSync', 'lchmod', 'lchmodSync', 'lchown', 'lchownSync', 'link', 'linkSync', 'symlink', 'symlinkSync',
    ] },
    'fs/promises': { members: ['writeFile', 'appendFile', 'copyFile', 'cp', 'rename', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'chmod', 'chown', 'lchmod', 'lchown', 'link', 'symlink'] },
  },
  ARCHIVE: {},
  DYNAMIC_CODE: { vm: { members: ['runInThisContext', 'runInNewContext', 'runInContext', 'compileFunction', 'Script', 'SourceTextModule', 'SyntheticModule'] } },
  SYSTEM: { os: { members: ['arch', 'cpus', 'endianness', 'freemem', 'homedir', 'hostname', 'loadavg', 'machine', 'networkInterfaces', 'platform', 'release', 'totalmem', 'type', 'uptime', 'userInfo', 'version'] } },
  CREDENTIAL: {}, SURVEILLANCE: {}, PERSISTENCE: {}, PUBLISH: {},
};

export const ACTION_GLOBALS: Record<ApiFamily, readonly string[]> = {
  NETWORK: ['fetch', 'XMLHttpRequest', 'WebSocket'], DYNAMIC_CODE: ['eval', 'Function'],
  PROCESS: [], FILE_READ: [], FILE_MUTATION: [], ARCHIVE: [], SYSTEM: [], CREDENTIAL: [], SURVEILLANCE: [], PERSISTENCE: [], PUBLISH: [],
};

export const EXTERNAL_ACTION_APIS: Record<ApiFamily, Record<string, ActionApi>> = {
  NETWORK: {
    axios: { callable: true, members: ['request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'postForm', 'putForm', 'patchForm'] },
    request: { callable: true, members: ['get', 'post', 'put', 'patch', 'del', 'delete', 'head'] },
    got: { callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head', 'stream', 'paginate'] },
    undici: { members: ['request', 'fetch', 'stream', 'pipeline', 'connect'] },
    'node-fetch': { callable: true }, 'cross-fetch': { callable: true },
    superagent: { callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options'] },
    needle: { callable: true, members: ['request', 'get', 'post', 'put', 'patch', 'delete', 'head'] },
  },
  PROCESS: {
    execa: { callable: true, members: ['execa', 'execaSync', 'execaCommand', 'execaCommandSync', 'execaNode', 'command', 'commandSync', 'sync', 'node', 'shell'] },
    shelljs: { members: ['exec'] }, 'cross-spawn': { callable: true, members: ['sync'] }, 'node-pty': { members: ['spawn'] },
  },
  FILE_READ: { 'fs-extra': { members: ['readFile', 'readFileSync', 'readdir', 'readdirSync', 'readJson', 'readJsonSync'] } },
  FILE_MUTATION: {
    'fs-extra': { members: ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'copy', 'copySync', 'move', 'moveSync', 'remove', 'removeSync', 'emptyDir', 'emptyDirSync', 'ensureDir', 'ensureDirSync', 'ensureFile', 'ensureFileSync', 'outputFile', 'outputFileSync', 'outputJson', 'outputJsonSync'] },
    shelljs: { members: ['rm', 'cp', 'mv', 'mkdir', 'chmod', 'touch', 'ln', 'sed'] },
  },
  ARCHIVE: {
    tar: { members: ['x', 'extract', 'c', 'create', 'r', 'replace', 'u', 'update'] }, 'tar-fs': { members: ['extract', 'pack'] },
    'extract-zip': { callable: true }, decompress: { callable: true }, unzipper: { members: ['Extract', 'Open.file', 'Open.buffer'] },
    'adm-zip': { members: ['().extractAllTo', '().extractAllToAsync', '().extractEntryTo', '().writeZip'] },
  },
  DYNAMIC_CODE: {},
  SYSTEM: { systeminformation: { members: [
    'system', 'bios', 'baseboard', 'chassis', 'osInfo', 'uuid', 'versions', 'cpu', 'cpuFlags', 'cpuCache', 'cpuCurrentSpeed', 'cpuTemperature',
    'graphics', 'mem', 'memLayout', 'battery', 'diskLayout', 'blockDevices', 'disksIO', 'fsSize', 'fsOpenFiles', 'usb', 'audio',
    'networkInterfaces', 'networkInterfaceDefault', 'networkGatewayDefault', 'networkStats', 'networkConnections', 'wifiNetworks', 'wifiInterfaces',
    'bluetoothDevices', 'processes', 'processLoad', 'currentLoad', 'fullLoad', 'users', 'services', 'dockerInfo',
  ] } },
  CREDENTIAL: { keytar: { members: ['getPassword', 'findPassword', 'findCredentials'] } },
  SURVEILLANCE: { clipboardy: { members: ['read', 'readSync'] }, 'screenshot-desktop': { callable: true }, 'active-win': { callable: true }, iohook: { members: ['on', 'once', 'start'] } },
  PERSISTENCE: { 'node-cron': { members: ['schedule'] }, croner: { callable: true, members: ['Cron'] } },
  PUBLISH: { libnpmpublish: { callable: true, members: ['publish'] } },
};

/** Known return types of factories. Only these exact factory/member combinations are propagated by the value resolver. */
export const BUILTIN_ACTION_FACTORIES: Record<string, Record<string, ActionFactoryApi>> = {
  dgram: { createSocket: { instance: { members: ['send'] } } },
};

export const EXTERNAL_ACTION_FACTORIES: Record<string, Record<string, ActionFactoryApi>> = {
  axios: { create: { instance: { members: ['request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'postForm', 'putForm', 'patchForm'] } } },
  got: { extend: { instance: { callable: true, members: ['get', 'post', 'put', 'patch', 'delete', 'head', 'stream', 'paginate'] } } },
  superagent: { agent: { instance: { members: ['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options'] } } },
};

export type CompositeStage = 'COLLECT' | 'SEND' | 'DOWNLOAD' | 'EXECUTE' | 'REMOTE_CHANNEL' | 'SHELL_EXECUTION';
export interface CompositeStageRule { stage: CompositeStage; families: readonly ApiFamily[] }

/** Behaviors whose ACTION is complete only as a connected composition, in data-flow order. */
export const COMPOSITE_ACTION_STAGES: Partial<Record<BehaviorGroup, readonly CompositeStageRule[]>> = {
  COLLECT_AND_SEND: [
    { stage: 'COLLECT', families: ['FILE_READ', 'CREDENTIAL', 'SYSTEM', 'SURVEILLANCE'] },
    { stage: 'SEND', families: ['NETWORK'] },
  ],
  DOWNLOAD_AND_EXECUTE: [
    { stage: 'DOWNLOAD', families: ['NETWORK'] },
    { stage: 'EXECUTE', families: ['PROCESS', 'DYNAMIC_CODE'] },
  ],
  REMOTE_SHELL: [
    { stage: 'REMOTE_CHANNEL', families: ['NETWORK'] },
    { stage: 'SHELL_EXECUTION', families: ['PROCESS'] },
  ],
};

export const ACTION_FAMILIES_BY_BEHAVIOR: Record<BehaviorGroup, readonly ApiFamily[]> = {
  NETWORK_SEND: ['NETWORK'], COLLECT_AND_SEND: ['FILE_READ', 'CREDENTIAL', 'SYSTEM', 'SURVEILLANCE', 'NETWORK'], SENSITIVE_READ: ['FILE_READ', 'CREDENTIAL'], ENVIRONMENT_READ: [], DOWNLOAD: ['NETWORK'],
  DOWNLOAD_AND_EXECUTE: ['NETWORK', 'PROCESS', 'ARCHIVE', 'DYNAMIC_CODE'], REMOTE_SHELL: ['NETWORK', 'PROCESS'], PROCESS_EXEC: ['PROCESS'],
  FILE_MUTATION: ['FILE_MUTATION', 'ARCHIVE'], LIFECYCLE: [], PERSISTENCE: ['PERSISTENCE', 'FILE_MUTATION', 'PROCESS'],
  SURVEILLANCE: ['SURVEILLANCE'], SYSTEM_DISCOVERY: ['SYSTEM'], PROPAGATION: ['PUBLISH', 'FILE_MUTATION', 'PROCESS', 'ARCHIVE'],
  DYNAMIC_CODE: ['DYNAMIC_CODE'], OTHER: [], OBFUSCATION_SIGNAL: [], PACKAGE_RISK: [],
};

/** Kept for diagnostics/tests: modules and globals come from the same central member policy. */
export const ACTION_API_FAMILIES: Record<ApiFamily, { modules: readonly string[]; globals: readonly string[] }> = Object.fromEntries(
  Object.keys(BUILTIN_ACTION_APIS).map((family) => [family, { modules: Object.keys(BUILTIN_ACTION_APIS[family as ApiFamily]), globals: ACTION_GLOBALS[family as ApiFamily] }]),
) as unknown as Record<ApiFamily, { modules: readonly string[]; globals: readonly string[] }>;

/** Shared with the Jev prompt: unlisted operations need the exact supplied Finding call or supplied implementation, never a suggestive name alone. */
export const ACTION_EVIDENCE_BOUNDARY = 'Treat a known API as an action only when both its static import/require origin and its exact callable member are visible; a factory-returned object counts only for an explicitly mapped factory/member pair. '
  + 'Recognize semantically equivalent operations in an unlisted library, SDK, socket instance, native binding, or shell command only when the supplied Finding statement is the exact operation call or the supplied implementation clearly performs the operation; a similar name or import alone never counts.';

const bare = (module: string): string => module.replace(/^node:/u, '');
const normalizedMember = (member: string | undefined): string | undefined => (
  member === undefined || member === 'default' ? undefined : member.replace(/^default\./u, '')
);
const matches = (api: ActionApi | undefined, member: string | undefined): boolean => {
  if (!api) return false;
  const name = normalizedMember(member);
  return name === undefined ? api.callable === true : api.members === '*' || api.members?.includes(name) === true;
};

const factoryMatches = (factories: Record<string, ActionFactoryApi> | undefined, member: string | undefined): boolean => {
  const name = normalizedMember(member);
  if (!factories || !name) return false;
  for (const [factory, api] of Object.entries(factories)) {
    if (name === `${factory}()` && api.instance.callable === true) return true;
    if (name.startsWith(`${factory}().`) && matches(api.instance, name.slice(factory.length + 3))) return true;
  }
  return false;
};

/** Marker placed on a value returned by an explicitly supported factory. */
export function actionFactoryResult(module: string, member: string | undefined): string | undefined {
  const name = normalizedMember(member);
  if (!name) return undefined;
  const factories = BUILTIN_ACTION_FACTORIES[bare(module)] ?? EXTERNAL_ACTION_FACTORIES[module];
  return factories?.[name] === undefined ? undefined : `${name}()`;
}

export function actionFamilyOf(behavior: BehaviorGroup, module: string, member: string | undefined): ApiFamily | undefined {
  return ACTION_FAMILIES_BY_BEHAVIOR[behavior].find((family) => (
    matches(BUILTIN_ACTION_APIS[family][bare(module)], member)
    || matches(EXTERNAL_ACTION_APIS[family][module], member)
    || factoryMatches(BUILTIN_ACTION_FACTORIES[bare(module)], member)
    || factoryMatches(EXTERNAL_ACTION_FACTORIES[module], member)
  ));
}

export function actionGlobalFamilyOf(behavior: BehaviorGroup, name: string): ApiFamily | undefined {
  return ACTION_FAMILIES_BY_BEHAVIOR[behavior].find((family) => ACTION_GLOBALS[family].includes(name));
}

export function isActionModule(behavior: BehaviorGroup, module: string, member?: string): boolean {
  return ACTION_FAMILIES_BY_BEHAVIOR[behavior].some((family) => matches(BUILTIN_ACTION_APIS[family][bare(module)], member)
    || factoryMatches(BUILTIN_ACTION_FACTORIES[bare(module)], member));
}

export function isActionGlobal(behavior: BehaviorGroup, name: string): boolean {
  return ACTION_FAMILIES_BY_BEHAVIOR[behavior].some((family) => ACTION_GLOBALS[family].includes(name));
}

export function isExternalAction(behavior: BehaviorGroup, module: string, member: string | undefined): boolean {
  return ACTION_FAMILIES_BY_BEHAVIOR[behavior].some((family) => matches(EXTERNAL_ACTION_APIS[family][module], member)
    || factoryMatches(EXTERNAL_ACTION_FACTORIES[module], member));
}
