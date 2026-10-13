import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CustomRuleProcessCapture,
  CustomRuleProcessRequest,
  CustomRuleProcessRunnerPort,
} from './custom-rule.analyzer';
import { dockerClientEnvironment, pinnedDockerImageReference } from '../guarddog/docker-external-guarddog.runner';

const execFile = promisify(nodeExecFile);
export const EXTERNAL_CUSTOM_RULE_SANDBOX_POLICY_VERSION = '1.0.0';
export const EXTERNAL_CUSTOM_RULE_ENVIRONMENT_VERSION = '1.0.0';
export const CONTAINER_PACKAGE_ROOT = '/analysis/package';
export const CONTAINER_RULESET_PATH = '/app/apps/scanner/rules/custom-rule-analyzer.yml';

export type ExternalCustomRuleFailureCode =
  | 'SEMGREP_EXECUTABLE_NOT_FOUND'
  | 'SEMGREP_VERSION_CHECK_FAILED'
  | 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE'
  | 'SEMGREP_RULESET_UNAVAILABLE'
  | 'SEMGREP_RULESET_HASH_MISMATCH'
  | 'SEMGREP_TIMEOUT'
  | 'SEMGREP_ANALYSIS_FAILED'
  | 'SEMGREP_OUTPUT_INVALID'
  | 'SANDBOX_PREFLIGHT_FAILED';

export interface DockerExternalCustomRulePolicy {
  runtime: 'docker';
  image: string;
  expectedImageDigest: `sha256:${string}`;
  expectedSemgrepVersion: '1.172.0';
  expectedRulesetSha256: string;
  user: '65532:65532';
  pidsLimit: number;
  memory: string;
  cpus: string;
  tmpfsSize: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExternalCustomRuleVerification {
  verified: boolean;
  mode: 'VERIFIED_NETWORK_NONE' | 'UNVERIFIED';
  reasonCode?: ExternalCustomRuleFailureCode;
  imageDigest: string;
  semgrepVersion: string;
  rulesetSha256: string;
  runtimeVersion: string;
  policyVersion: string;
  environmentVersion: string;
  mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT_IMAGE_RULESET';
  rootFilesystem: 'READ_ONLY';
  resourceLimits: { pids: number; memory: string; cpus: string; tmpfsSize: string; timeoutMs: number };
}

export interface ExternalCustomRuleSandboxPort {
  preflight(packageRoot: string): Promise<ExternalCustomRuleVerification>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}
type CommandExecutor = (file: string, args: readonly string[], options: {
  timeoutMs: number; maxOutputBytes: number; environment: NodeJS.ProcessEnv;
}) => Promise<CommandResult>;

export class DockerExternalCustomRuleRunner
implements CustomRuleProcessRunnerPort, ExternalCustomRuleSandboxPort {
  constructor(
    private readonly policy: DockerExternalCustomRulePolicy,
    private readonly executeCommand: CommandExecutor = execute,
  ) { validatePolicy(policy); }

  async preflight(packageRoot: string): Promise<ExternalCustomRuleVerification> {
    const failure = (reasonCode: ExternalCustomRuleFailureCode): ExternalCustomRuleVerification => ({
      verified: false, mode: 'UNVERIFIED', reasonCode,
      imageDigest: this.policy.expectedImageDigest, semgrepVersion: 'unavailable', rulesetSha256: 'unavailable',
      runtimeVersion: 'unavailable', policyVersion: EXTERNAL_CUSTOM_RULE_SANDBOX_POLICY_VERSION,
      environmentVersion: EXTERNAL_CUSTOM_RULE_ENVIRONMENT_VERSION,
      mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT_IMAGE_RULESET', rootFilesystem: 'READ_ONLY',
      resourceLimits: limits(this.policy),
    });
    try {
      const runtime = await this.executeCommand(this.policy.runtime,
        ['version', '--format', '{{.Server.Version}}'], commandOptions(this.policy));
      if (runtime.exitCode !== 0 || runtime.stdout.trim() === '') return failure('SANDBOX_PREFLIGHT_FAILED');
      const inspected = await this.executeCommand(this.policy.runtime,
        ['image', 'inspect', this.imageReference(), '--format', '{{json .}}'], commandOptions(this.policy));
      if (inspected.exitCode !== 0) return failure('SANDBOX_PREFLIGHT_FAILED');
      const image = JSON.parse(inspected.stdout) as { Id?: unknown; Config?: { User?: unknown } };
      if (image.Id !== this.policy.expectedImageDigest) return failure('SANDBOX_PREFLIGHT_FAILED');
      if (image.Config?.User !== this.policy.user) return failure('SANDBOX_PREFLIGHT_FAILED');

      const diagnostic = await this.executeCommand(this.policy.runtime,
        dockerRunArguments(this.policy, packageRoot, ['/bin/sh', '-c', diagnosticScript()]), commandOptions(this.policy));
      if (diagnostic.timedOut) return failure('SEMGREP_TIMEOUT');
      if (diagnostic.exitCode !== 0) return failure(diagnosticFailure(diagnostic));
      const parsed = parseDiagnostic(diagnostic.stdout);
      if (parsed.semgrepVersion !== this.policy.expectedSemgrepVersion) return failure('SEMGREP_VERSION_CHECK_FAILED');
      if (parsed.rulesetSha256 !== this.policy.expectedRulesetSha256) return failure('SEMGREP_RULESET_HASH_MISMATCH');
      return {
        verified: true, mode: 'VERIFIED_NETWORK_NONE', imageDigest: this.policy.expectedImageDigest,
        semgrepVersion: parsed.semgrepVersion, rulesetSha256: parsed.rulesetSha256,
        runtimeVersion: runtime.stdout.trim(), policyVersion: EXTERNAL_CUSTOM_RULE_SANDBOX_POLICY_VERSION,
        environmentVersion: EXTERNAL_CUSTOM_RULE_ENVIRONMENT_VERSION,
        mountPolicy: 'SINGLE_READ_ONLY_PACKAGE_ROOT_IMAGE_RULESET', rootFilesystem: 'READ_ONLY',
        resourceLimits: limits(this.policy),
      };
    } catch { return failure('SANDBOX_PREFLIGHT_FAILED'); }
  }

  async run(request: CustomRuleProcessRequest): Promise<CustomRuleProcessCapture> {
    const mapped = request.args.map((argument) => {
      if (argument === request.packageRoot) return CONTAINER_PACKAGE_ROOT;
      if (argument === request.ruleConfigPath) return CONTAINER_RULESET_PATH;
      return argument;
    });
    if (!mapped.includes(CONTAINER_PACKAGE_ROOT) || !mapped.includes(CONTAINER_RULESET_PATH)) {
      return failureCapture('External Custom Rule paths were not safely mapped');
    }
    mapped.push('--disable-version-check', '--metrics', 'off');
    const result = await this.executeCommand(this.policy.runtime,
      dockerRunArguments(this.policy, request.packageRoot, ['semgrep', ...mapped]), {
        ...commandOptions(this.policy), timeoutMs: Math.min(request.timeoutMs, this.policy.timeoutMs),
      });
    const failureReasonCode = analysisFailure(result);
    return {
      stdout: normalizeContainerPaths(result.stdout),
      stderr: sanitize(result.stderr, request.packageRoot), exitCode: result.exitCode, signal: null,
      timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded,
      ...(failureReasonCode === undefined ? {} : { failureReasonCode }),
      ...(result.exitCode === null && !result.timedOut ? { spawnError: new Error('SEMGREP_ANALYSIS_FAILED') } : {}),
    };
  }

  private imageReference(): string { return pinnedDockerImageReference(this.policy); }
}

export function customRuleDockerArguments(
  policy: DockerExternalCustomRulePolicy, packageRoot: string, command: readonly string[],
): string[] { return dockerRunArguments(policy, packageRoot, command); }

function dockerRunArguments(policy: DockerExternalCustomRulePolicy, packageRoot: string, command: readonly string[]): string[] {
  return [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--pids-limit', String(policy.pidsLimit),
    '--memory', policy.memory, '--cpus', policy.cpus, '--user', policy.user,
    '--env', 'HOME=/tmp', '--env', 'XDG_CONFIG_HOME=/tmp/xdg-config',
    '--env', 'XDG_CACHE_HOME=/tmp/xdg-cache', '--env', 'SEMGREP_SETTINGS_FILE=/tmp/semgrep-settings.yml',
    '--env', 'SEMGREP_ENABLE_VERSION_CHECK=0', '--env', 'SEMGREP_SEND_METRICS=off',
    '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${policy.tmpfsSize}`,
    '--mount', `type=bind,src=${packageRoot},dst=${CONTAINER_PACKAGE_ROOT},readonly`,
    '--entrypoint', command[0] ?? 'semgrep', pinnedDockerImageReference(policy), ...command.slice(1),
  ];
}

function diagnosticScript(): string {
  return [
    'set -eu', 'test "$(id -u)" = 65532', 'test ! -e /var/run/docker.sock',
    'test -z "${OPENAI_API_KEY:-}"', 'test -z "${AWS_SECRET_ACCESS_KEY:-}"',
    'if touch /analysis/package/write-test 2>/dev/null; then exit 41; fi',
    'mkdir -p /tmp/xdg-config /tmp/xdg-cache', 'touch /tmp/semgrep-settings.yml',
    'test "$(semgrep --version --disable-version-check)" = "1.172.0"',
    `test -r ${CONTAINER_RULESET_PATH}`,
    `RULE_HASH=$(sha256sum ${CONTAINER_RULESET_PATH} | cut -d " " -f 1)`,
    `node -e 'const dns=require("node:dns").promises;const net=require("node:net");Promise.all([dns.lookup("example.com").then(()=>{throw Error("DNS_SUCCEEDED")},()=>true),new Promise((resolve,reject)=>{const s=net.connect({host:"1.1.1.1",port:443,timeout:1000});s.on("connect",()=>reject(Error("TCP_SUCCEEDED")));s.on("error",()=>resolve(true));s.on("timeout",()=>{s.destroy();resolve(true)})})]).then(()=>{},()=>process.exit(42))'`,
    'printf "SEMGREP_VERSION=1.172.0\\nRULESET_SHA256=%s\\nDIAGNOSTICS_OK\\n" "$RULE_HASH"',
  ].join(';');
}

function parseDiagnostic(stdout: string): { semgrepVersion: string; rulesetSha256: string } {
  const version = /^SEMGREP_VERSION=(.+)$/mu.exec(stdout)?.[1];
  const hash = /^RULESET_SHA256=([a-f0-9]{64})$/mu.exec(stdout)?.[1];
  if (!stdout.includes('DIAGNOSTICS_OK') || !version || !hash) throw new Error('DIAGNOSTIC_OUTPUT_INVALID');
  return { semgrepVersion: version, rulesetSha256: hash };
}
function diagnosticFailure(result: CommandResult): ExternalCustomRuleFailureCode {
  if (result.outputLimitExceeded) return 'SEMGREP_OUTPUT_INVALID';
  if (result.stderr.includes('settings') || result.stderr.includes('Read-only file system')) return 'SEMGREP_RUNTIME_CONFIG_UNWRITABLE';
  if (result.stderr.includes('not found')) return 'SEMGREP_EXECUTABLE_NOT_FOUND';
  return 'SANDBOX_PREFLIGHT_FAILED';
}
function analysisFailure(result: CommandResult): ExternalCustomRuleFailureCode | undefined {
  if (result.timedOut) return 'SEMGREP_TIMEOUT';
  if (result.outputLimitExceeded) return 'SEMGREP_OUTPUT_INVALID';
  if (result.exitCode !== 0) return 'SEMGREP_ANALYSIS_FAILED';
  try {
    const parsed = JSON.parse(result.stdout) as { results?: unknown };
    if (!Array.isArray(parsed.results)) return 'SEMGREP_OUTPUT_INVALID';
  } catch { return 'SEMGREP_OUTPUT_INVALID'; }
  return undefined;
}
function commandOptions(policy: DockerExternalCustomRulePolicy): Parameters<CommandExecutor>[2] {
  return { timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, environment: dockerClientEnvironment(process.env) };
}
async function execute(file: string, args: readonly string[], options: Parameters<CommandExecutor>[2]): Promise<CommandResult> {
  try {
    const value = await execFile(file, [...args], { timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes,
      env: options.environment, encoding: 'utf8', windowsHide: true });
    return { stdout: value.stdout, stderr: value.stderr, exitCode: 0, timedOut: false, outputLimitExceeded: false };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; message?: string };
    const outputLimitExceeded = value.message?.includes('maxBuffer') === true;
    return { stdout: value.stdout ?? '', stderr: value.stderr ?? '', exitCode: typeof value.code === 'number' ? value.code : null,
      timedOut: value.killed === true && !outputLimitExceeded, outputLimitExceeded };
  }
}
function validatePolicy(policy: DockerExternalCustomRulePolicy): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(policy.expectedImageDigest)) throw new Error('Invalid image digest');
  if (!/^[a-f0-9]{64}$/u.test(policy.expectedRulesetSha256)) throw new Error('Invalid ruleset hash');
  if (policy.image.includes('@') || policy.image.trim() === '') throw new Error('Invalid image name');
  pinnedDockerImageReference(policy);
  if (policy.user !== '65532:65532') throw new Error('External Custom Rule user must be 65532:65532');
  for (const value of [policy.pidsLimit, policy.timeoutMs, policy.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Sandbox limits must be positive integers');
  }
}
function limits(policy: DockerExternalCustomRulePolicy): ExternalCustomRuleVerification['resourceLimits'] {
  return { pids: policy.pidsLimit, memory: policy.memory, cpus: policy.cpus, tmpfsSize: policy.tmpfsSize, timeoutMs: policy.timeoutMs };
}
function normalizeContainerPaths(value: string): string {
  return value.split(`${CONTAINER_PACKAGE_ROOT}/`).join('').split(CONTAINER_PACKAGE_ROOT).join('.').split(CONTAINER_RULESET_PATH).join('<RULESET>');
}
function sanitize(value: string, hostRoot: string): string {
  return normalizeContainerPaths(value.split(hostRoot).join('<PACKAGE_ROOT>')).slice(0, 16_384);
}
function failureCapture(message: string): CustomRuleProcessCapture {
  return { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, outputLimitExceeded: false, spawnError: new Error(message) };
}
