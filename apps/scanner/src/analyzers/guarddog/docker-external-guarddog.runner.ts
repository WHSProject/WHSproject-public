import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  GuardDogProcessRequest,
  GuardDogProcessResult,
} from './guarddog.types';
import type { GuardDogProcessRunnerPort } from './guarddog-process.runner';

const execFile = promisify(nodeExecFile);
export const EXTERNAL_GUARDDOG_SANDBOX_POLICY_VERSION = '1.0.0';

export interface DockerExternalGuardDogPolicy {
  runtime: 'docker';
  image: string;
  expectedImageDigest: `sha256:${string}`;
  user: `${number}:${number}`;
  pidsLimit: number;
  memory: string;
  cpus: string;
  tmpfsSize: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExternalSandboxVerification {
  verified: boolean;
  mode: 'VERIFIED_NETWORK_NONE' | 'UNVERIFIED';
  mechanism: 'DOCKER_NETWORK_NONE';
  imageDigest: string;
  runtimeVersion: string;
  policyVersion: string;
  mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT';
  rootFilesystem: 'READ_ONLY';
  resourceLimits: { pids: number; memory: string; cpus: string; tmpfsSize: string; timeoutMs: number };
  reasonCode?: string;
}

export interface ExternalGuardDogSandboxPort {
  preflight(packageRoot: string): Promise<ExternalSandboxVerification>;
}

interface CommandResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }
type CommandExecutor = (file: string, args: readonly string[], options: {
  timeoutMs: number; maxOutputBytes: number; environment: NodeJS.ProcessEnv;
}) => Promise<CommandResult>;

export class DockerExternalGuardDogRunner
implements GuardDogProcessRunnerPort, ExternalGuardDogSandboxPort {
  constructor(
    private readonly policy: DockerExternalGuardDogPolicy,
    private readonly executeCommand: CommandExecutor = execute,
  ) {
    validatePolicy(policy);
  }

  async preflight(packageRoot: string): Promise<ExternalSandboxVerification> {
    const failure = (reasonCode: string): ExternalSandboxVerification => ({
      verified: false, mode: 'UNVERIFIED', mechanism: 'DOCKER_NETWORK_NONE',
      imageDigest: this.policy.expectedImageDigest, runtimeVersion: 'unavailable',
      policyVersion: EXTERNAL_GUARDDOG_SANDBOX_POLICY_VERSION, reasonCode,
      mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT', rootFilesystem: 'READ_ONLY',
      resourceLimits: limits(this.policy),
    });
    try {
      const version = await this.executeCommand(this.policy.runtime, ['version', '--format', '{{.Server.Version}}'], commandOptions(this.policy));
      if (version.exitCode !== 0 || version.stdout.trim() === '') return failure('CONTAINER_DAEMON_UNAVAILABLE');
      const inspected = await this.executeCommand(this.policy.runtime, [
        'image', 'inspect', this.imageReference(), '--format', '{{json .}}',
      ], commandOptions(this.policy));
      if (inspected.exitCode !== 0) return failure('CONTAINER_IMAGE_UNAVAILABLE');
      const image = JSON.parse(inspected.stdout) as { Id?: unknown; Architecture?: unknown; Config?: { User?: unknown } };
      if (image.Id !== this.policy.expectedImageDigest) return failure('CONTAINER_IMAGE_DIGEST_MISMATCH');
      if (image.Architecture !== 'arm64' && image.Architecture !== 'amd64') return failure('CONTAINER_IMAGE_ARCH_UNSUPPORTED');
      if (typeof image.Config?.User !== 'string' || image.Config.User === '' || /^0(?::0)?$/u.test(image.Config.User)) {
        return failure('CONTAINER_IMAGE_ROOT_USER');
      }
      const diagnostic = await this.executeCommand(this.policy.runtime,
        dockerRunArguments(this.policy, packageRoot, diagnosticCommand()), commandOptions(this.policy));
      if (diagnostic.timedOut) return failure('SANDBOX_DIAGNOSTIC_TIMEOUT');
      if (diagnostic.exitCode !== 0 || diagnostic.stdout.trim() !== 'DIAGNOSTICS_OK') {
        return failure('SANDBOX_DIAGNOSTIC_FAILED');
      }
      return {
        verified: true, mode: 'VERIFIED_NETWORK_NONE', mechanism: 'DOCKER_NETWORK_NONE',
        imageDigest: this.policy.expectedImageDigest, runtimeVersion: version.stdout.trim(),
        policyVersion: EXTERNAL_GUARDDOG_SANDBOX_POLICY_VERSION,
        mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT', rootFilesystem: 'READ_ONLY',
        resourceLimits: limits(this.policy),
      };
    } catch {
      return failure('SANDBOX_PREFLIGHT_FAILED');
    }
  }

  async run(request: GuardDogProcessRequest): Promise<GuardDogProcessResult> {
    const started = new Date();
    const artifact = request.externalArtifact;
    if (artifact === undefined) return processFailure(started, 'External artifact metadata is required');
    const mappedArgs = request.args.map((argument) => argument === artifact.packageRoot
      ? artifact.containerPackageRoot : argument);
    if (!mappedArgs.includes(artifact.containerPackageRoot)) {
      return processFailure(started, 'GuardDog target path was not mapped into the container');
    }
    if (!mappedArgs.includes('--no-sandbox')) mappedArgs.push('--no-sandbox');
    const args = dockerRunArguments(this.policy, artifact.packageRoot, ['guarddog', ...mappedArgs]);
    const result = await this.executeCommand(this.policy.runtime, args, {
      ...commandOptions(this.policy), timeoutMs: Math.min(request.timeoutMs, this.policy.timeoutMs),
      maxOutputBytes: Math.min(request.maxOutputBytes, this.policy.maxOutputBytes),
    });
    const completed = new Date();
    return {
      exitCode: result.exitCode,
      signal: null,
      stdout: normalizeContainerPaths(result.stdout, artifact.containerPackageRoot),
      stderr: sanitizeStderr(result.stderr, artifact.packageRoot),
      startedAt: started.toISOString(), completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
      timedOut: result.timedOut,
      outputLimitExceeded: Buffer.byteLength(result.stdout) >= this.policy.maxOutputBytes
        || Buffer.byteLength(result.stderr) >= this.policy.maxOutputBytes,
      command: sanitizedCommand(this.policy, mappedArgs),
      terminationErrors: [],
    };
  }

  private imageReference(): string {
    return pinnedDockerImageReference(this.policy);
  }
}

export function dockerRunArguments(
  policy: DockerExternalGuardDogPolicy,
  packageRoot: string,
  command: readonly string[],
): string[] {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--pids-limit', String(policy.pidsLimit),
    '--memory', policy.memory, '--cpus', policy.cpus, '--user', policy.user,
    '--env', 'HOME=/tmp', '--env', 'XDG_CACHE_HOME=/tmp/cache',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize}`,
    '--mount', `type=bind,src=${packageRoot},dst=/analysis/package,readonly`,
    '--entrypoint', command[0] ?? 'guarddog',
    pinnedDockerImageReference(policy),
    ...command.slice(1),
  ];
}

function diagnosticCommand(): string[] {
  const script = [
    'set -eu',
    'test "$(id -u)" != 0',
    'test ! -e /var/run/docker.sock',
    'test -z "${OPENAI_API_KEY:-}"',
    'test -z "${AWS_SECRET_ACCESS_KEY:-}"',
    'if touch /analysis/package/write-test 2>/dev/null; then exit 41; fi',
    'touch /tmp/write-test',
    `node -e 'const dns=require("node:dns").promises;const net=require("node:net");Promise.all([dns.lookup("example.com").then(()=>{throw Error("DNS_SUCCEEDED")},()=>true),new Promise((resolve,reject)=>{const s=net.connect({host:"1.1.1.1",port:443,timeout:1500});s.on("connect",()=>reject(Error("TCP_SUCCEEDED")));s.on("error",()=>resolve(true));s.on("timeout",()=>{s.destroy();resolve(true)})})]).then(()=>process.stdout.write("DIAGNOSTICS_OK"),()=>process.exit(42))'`,
  ].join(';');
  return ['/bin/sh', '-c', script];
}

function commandOptions(policy: DockerExternalGuardDogPolicy): Parameters<CommandExecutor>[2] {
  return { timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, environment: dockerClientEnvironment(process.env) };
}

export function dockerClientEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (source[key] !== undefined) output[key] = source[key];
  }
  return output;
}

async function execute(file: string, args: readonly string[], options: Parameters<CommandExecutor>[2]): Promise<CommandResult> {
  try {
    const value = await execFile(file, [...args], {
      timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, env: options.environment,
      encoding: 'utf8', windowsHide: true,
    });
    return { stdout: value.stdout, stderr: value.stderr, exitCode: 0, timedOut: false };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: value.stdout ?? '', stderr: value.stderr ?? '',
      exitCode: typeof value.code === 'number' ? value.code : null,
      timedOut: value.killed === true,
    };
  }
}

function validatePolicy(policy: DockerExternalGuardDogPolicy): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(policy.expectedImageDigest)) throw new Error('Invalid image digest');
  if (policy.image.includes('@') || policy.image.trim() === '') throw new Error('Image name must not contain a digest');
  pinnedDockerImageReference(policy);
  if (/^0(?::0)?$/u.test(policy.user)) throw new Error('External GuardDog user must be non-root');
  for (const value of [policy.pidsLimit, policy.timeoutMs, policy.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Sandbox limits must be positive integers');
  }
}

function normalizeContainerPaths(stdout: string, root: string): string {
  return stdout.split(`${root}/`).join('').split(root).join('.');
}
function limits(policy: DockerExternalGuardDogPolicy): ExternalSandboxVerification['resourceLimits'] {
  return { pids: policy.pidsLimit, memory: policy.memory, cpus: policy.cpus,
    tmpfsSize: policy.tmpfsSize, timeoutMs: policy.timeoutMs };
}
function sanitizeStderr(stderr: string, hostRoot: string): string {
  return stderr.split(hostRoot).join('<PACKAGE_ROOT>').slice(0, 16_384);
}
function sanitizedCommand(policy: DockerExternalGuardDogPolicy, command: readonly string[]): string[] {
  return [policy.runtime, 'run', '<SANDBOX_OPTIONS>', '--mount', '<READ_ONLY_PACKAGE_ROOT>',
    pinnedDockerImageReference(policy), ...command];
}

/** Local image IDs are immutable too; never append a repository digest to an ID. */
export function pinnedDockerImageReference(policy: { image: string; expectedImageDigest: string }): string {
  if (policy.image.startsWith('sha256:')) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(policy.image) || policy.image !== policy.expectedImageDigest) {
      throw new Error('Local image ID must equal the expected image digest');
    }
    return policy.image;
  }
  return `${policy.image}@${policy.expectedImageDigest}`;
}
function processFailure(started: Date, message: string): GuardDogProcessResult {
  const completed = new Date();
  return { exitCode: null, signal: null, stdout: '', stderr: '', startedAt: started.toISOString(),
    completedAt: completed.toISOString(), durationMs: completed.getTime() - started.getTime(), timedOut: false,
    outputLimitExceeded: false, command: [], processError: { message }, terminationErrors: [] };
}
