import {
  CONTAINER_PACKAGE_ROOT,
  CONTAINER_RULESET_PATH,
  customRuleDockerArguments,
  DockerExternalCustomRuleRunner,
  type DockerExternalCustomRulePolicy,
} from '../src/analyzers/custom-rule/docker-external-custom-rule.runner';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const RULE_HASH = 'b'.repeat(64);
const policy: DockerExternalCustomRulePolicy = {
  runtime: 'docker', image: 'scanner-external', expectedImageDigest: DIGEST,
  expectedSemgrepVersion: '1.172.0', expectedRulesetSha256: RULE_HASH,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1', tmpfsSize: '64m',
  timeoutMs: 1_000, maxOutputBytes: 4_096,
};
const success = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, timedOut: false, outputLimitExceeded: false });

describe('DockerExternalCustomRuleRunner', () => {
  it('uses an exact local image ID without changing any sandbox arguments', () => {
    const command = ['semgrep', '--json'];
    const named = customRuleDockerArguments(policy, '/host/pkg', command);
    const local = customRuleDockerArguments({ ...policy, image: DIGEST }, '/host/pkg', command);
    expect(local).toEqual(named.map((value) => value === `${policy.image}@${DIGEST}` ? DIGEST : value));
  });

  it.each([`sha256:${'c'.repeat(64)}`, 'sha256:short'])('rejects mismatched or malformed local image ID %s', (image) => {
    expect(() => new DockerExternalCustomRuleRunner({ ...policy, image })).toThrow('Local image ID');
  });

  it('still checks the image, tool version and ruleset with a local image ID', async () => {
    const execute = jest.fn().mockResolvedValueOnce(success('29'))
      .mockResolvedValueOnce(success(JSON.stringify({ Id: DIGEST, Config: { User: '65532:65532' } })))
      .mockResolvedValueOnce(success(`SEMGREP_VERSION=1.172.0\nRULESET_SHA256=${RULE_HASH}\nDIAGNOSTICS_OK\n`));
    await expect(new DockerExternalCustomRuleRunner({ ...policy, image: DIGEST }, execute).preflight('/host/pkg'))
      .resolves.toMatchObject({ verified: true });
    expect(execute.mock.calls[1]?.[1]).toEqual(['image', 'inspect', DIGEST, '--format', '{{json .}}']);
    expect(execute.mock.calls[2]?.[1]).toContain(DIGEST);
  });

  it('builds the required fail-closed sandbox command and exposes no host environment', () => {
    const args = customRuleDockerArguments(policy, '/host/pkg', ['semgrep', '--json']);
    expect(args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--user', '65532:65532', '--pids-limit', '64', '--memory', '512m', '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--mount', `type=bind,src=/host/pkg,dst=${CONTAINER_PACKAGE_ROOT},readonly`,
      '--env', 'SEMGREP_SETTINGS_FILE=/tmp/semgrep-settings.yml',
    ]));
    expect(args.join(' ')).not.toContain('/var/run/docker.sock');
    if (process.env.OPENAI_API_KEY) expect(args.join(' ')).not.toContain(process.env.OPENAI_API_KEY);
  });

  it('verifies runtime, non-root image, network/write diagnostics, Semgrep, and ruleset hash', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce(success('27.0.0\n'))
      .mockResolvedValueOnce(success(JSON.stringify({ Id: DIGEST, Config: { User: '65532:65532' } })))
      .mockResolvedValueOnce(success(`SEMGREP_VERSION=1.172.0\nRULESET_SHA256=${RULE_HASH}\nDIAGNOSTICS_OK\n`));
    const actual = await new DockerExternalCustomRuleRunner(policy, execute).preflight('/host/pkg');
    expect(actual).toMatchObject({ verified: true, mode: 'VERIFIED_NETWORK_NONE', semgrepVersion: '1.172.0', rulesetSha256: RULE_HASH });
    const diagnosticArgs = execute.mock.calls[2]?.[1] as string[];
    expect(diagnosticArgs.join(' ')).toContain('dns.lookup');
    expect(diagnosticArgs.join(' ')).toContain('touch /analysis/package/write-test');
    expect(diagnosticArgs.join(' ')).toContain('touch /tmp/semgrep-settings.yml');
  });

  it.each([
    ['wrong ruleset hash', `SEMGREP_VERSION=1.172.0\nRULESET_SHA256=${'c'.repeat(64)}\nDIAGNOSTICS_OK\n`, 'SEMGREP_RULESET_HASH_MISMATCH'],
    ['wrong version', `SEMGREP_VERSION=1.171.0\nRULESET_SHA256=${RULE_HASH}\nDIAGNOSTICS_OK\n`, 'SEMGREP_VERSION_CHECK_FAILED'],
    ['malformed diagnostic', 'not-json', 'SANDBOX_PREFLIGHT_FAILED'],
  ])('fails closed for %s', async (_label, output, reasonCode) => {
    const execute = jest.fn().mockResolvedValueOnce(success('27'))
      .mockResolvedValueOnce(success(JSON.stringify({ Id: DIGEST, Config: { User: '65532:65532' } })))
      .mockResolvedValueOnce(success(output));
    await expect(new DockerExternalCustomRuleRunner(policy, execute).preflight('/host/pkg'))
      .resolves.toMatchObject({ verified: false, reasonCode });
  });

  it('maps only package and image ruleset paths, adds offline flags, and normalizes output paths', async () => {
    const execute = jest.fn().mockResolvedValue(success(JSON.stringify({ results: [{
      check_id: 'custom.signal.network-access', path: '/analysis/package/index.js',
      start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, extra: { message: 'x' },
    }], errors: [] })));
    const actual = await new DockerExternalCustomRuleRunner(policy, execute).run({
      executable: 'semgrep', args: ['--json', '--config', '/host/rules.yml', '/host/pkg'],
      packageRoot: '/host/pkg', ruleConfigPath: '/host/rules.yml', timeoutMs: 500,
    });
    expect(actual.stdout).toContain('index.js');
    expect(actual.stdout).not.toContain('/analysis/package');
    const args = execute.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining([CONTAINER_RULESET_PATH, CONTAINER_PACKAGE_ROOT, '--disable-version-check', '--metrics', 'off']));
    expect(args.join(' ')).not.toContain('/host/rules.yml');
  });

  it('fails before Docker execution when paths are not mapped', async () => {
    const execute = jest.fn();
    const actual = await new DockerExternalCustomRuleRunner(policy, execute).run({
      executable: 'semgrep', args: ['--json'], packageRoot: '/host/pkg', ruleConfigPath: '/host/rules', timeoutMs: 10,
    });
    expect(actual.spawnError?.message).toContain('safely mapped');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', { stdout: '', stderr: '', exitCode: null, timedOut: true, outputLimitExceeded: false }, 'SEMGREP_TIMEOUT'],
    ['non-zero', { stdout: '{}', stderr: 'failed', exitCode: 2, timedOut: false, outputLimitExceeded: false }, 'SEMGREP_ANALYSIS_FAILED'],
    ['oversized', { stdout: 'x', stderr: '', exitCode: null, timedOut: false, outputLimitExceeded: true }, 'SEMGREP_OUTPUT_INVALID'],
  ])('preserves %s process state', async (_label, capture, failureReasonCode) => {
    const runner = new DockerExternalCustomRuleRunner(policy, jest.fn().mockResolvedValue(capture));
    await expect(runner.run({ executable: 'semgrep', args: ['--config', '/r', '/p'], packageRoot: '/p', ruleConfigPath: '/r', timeoutMs: 10 }))
      .resolves.toMatchObject({ ...capture, failureReasonCode });
  });

  it('classifies malformed JSON from a zero exit as SEMGREP_OUTPUT_INVALID', async () => {
    const runner = new DockerExternalCustomRuleRunner(policy, jest.fn().mockResolvedValue(success('{bad-json')));
    await expect(runner.run({ executable: 'semgrep', args: ['--config', '/r', '/p'], packageRoot: '/p', ruleConfigPath: '/r', timeoutMs: 10 }))
      .resolves.toMatchObject({ failureReasonCode: 'SEMGREP_OUTPUT_INVALID' });
  });
});
