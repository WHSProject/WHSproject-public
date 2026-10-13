import {
  DockerExternalGuardDogRunner,
  dockerClientEnvironment,
  dockerRunArguments,
  type DockerExternalGuardDogPolicy,
} from '../src/analyzers/guarddog/docker-external-guarddog.runner';
import type { GuardDogProcessRequest } from '../src/analyzers/guarddog/guarddog.types';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const policy: DockerExternalGuardDogPolicy = {
  runtime: 'docker', image: 'scanner-guarddog', expectedImageDigest: DIGEST,
  user: '65532:65532', pidsLimit: 64, memory: '512m', cpus: '1',
  tmpfsSize: '64m', timeoutMs: 10_000, maxOutputBytes: 1024 * 1024,
};

function request(): GuardDogProcessRequest {
  return {
    executable: 'guarddog', args: ['npm', 'scan', '/host/package', '--output-format=json'],
    timeoutMs: 5_000, killGraceMs: 100, maxOutputBytes: 1024 * 1024,
    externalArtifact: { packageRoot: '/host/package', containerPackageRoot: '/analysis/package' },
  };
}

describe('DockerExternalGuardDogRunner', () => {
  it('uses an exact local image ID without changing any sandbox arguments', () => {
    const command = ['guarddog', 'npm', 'scan', '/analysis/package'];
    const named = dockerRunArguments(policy, '/host/package', command);
    const local = dockerRunArguments({ ...policy, image: DIGEST }, '/host/package', command);
    expect(local).toEqual(named.map((value) => value === `${policy.image}@${DIGEST}` ? DIGEST : value));
  });

  it.each([`sha256:${'b'.repeat(64)}`, 'sha256:short'])('rejects mismatched or malformed local image ID %s', (image) => {
    expect(() => new DockerExternalGuardDogRunner({ ...policy, image })).toThrow('Local image ID');
  });

  it('still verifies inspected identity and diagnostics when a local ID is configured', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce({ stdout: '29', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ Id: DIGEST, Architecture: 'arm64', Config: { User: '65532:65532' } }), stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: 'DIAGNOSTICS_OK', stderr: '', exitCode: 0, timedOut: false });
    await expect(new DockerExternalGuardDogRunner({ ...policy, image: DIGEST }, execute).preflight('/host/package'))
      .resolves.toMatchObject({ verified: true });
    expect(execute.mock.calls[1]?.[1]).toEqual(['image', 'inspect', DIGEST, '--format', '{{json .}}']);
    expect(execute.mock.calls[2]?.[1]).toContain(DIGEST);
  });

  it('builds the mandatory sandbox command without extra mounts or privileges', () => {
    const args = dockerRunArguments(policy, '/host/package', ['guarddog', 'npm', 'scan', '/analysis/package']);
    expect(args).toEqual(expect.arrayContaining([
      '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges=true', '--pids-limit', '64',
      '--memory', '512m', '--cpus', '1', '--user', '65532:65532',
      '--env', 'HOME=/tmp', '--env', 'XDG_CACHE_HOME=/tmp/cache',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--mount', 'type=bind,src=/host/package,dst=/analysis/package,readonly',
    ]));
    expect(args.join(' ')).not.toMatch(/privileged|docker\.sock|--pid=host|--ipc=host/u);
    expect(args.filter((value) => value === '--mount')).toHaveLength(1);
  });

  it('does not pass host secrets to the Docker client', () => {
    expect(dockerClientEnvironment({ PATH: '/bin', HOME: '/home/test', OPENAI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret' }))
      .toEqual({ PATH: '/bin', HOME: '/home/test' });
  });

  it('verifies daemon, exact image identity, non-root image, and diagnostics', async () => {
    const execute = jest.fn()
      .mockResolvedValueOnce({ stdout: '29.2.1\n', stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ Id: DIGEST, Architecture: 'arm64', Config: { User: '65532:65532' } }), stderr: '', exitCode: 0, timedOut: false })
      .mockResolvedValueOnce({ stdout: 'DIAGNOSTICS_OK', stderr: '', exitCode: 0, timedOut: false });
    await expect(new DockerExternalGuardDogRunner(policy, execute).preflight('/host/package'))
      .resolves.toMatchObject({ verified: true, mode: 'VERIFIED_NETWORK_NONE' });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['CONTAINER_DAEMON_UNAVAILABLE', [{ stdout: '', stderr: '', exitCode: 1, timedOut: false }]],
    ['CONTAINER_IMAGE_UNAVAILABLE', [
      { stdout: '29', stderr: '', exitCode: 0, timedOut: false },
      { stdout: '', stderr: '', exitCode: 1, timedOut: false },
    ]],
    ['CONTAINER_IMAGE_DIGEST_MISMATCH', [
      { stdout: '29', stderr: '', exitCode: 0, timedOut: false },
      { stdout: JSON.stringify({ Id: `sha256:${'b'.repeat(64)}`, Architecture: 'arm64', Config: { User: '65532:65532' } }), stderr: '', exitCode: 0, timedOut: false },
    ]],
    ['CONTAINER_IMAGE_ROOT_USER', [
      { stdout: '29', stderr: '', exitCode: 0, timedOut: false },
      { stdout: JSON.stringify({ Id: DIGEST, Architecture: 'arm64', Config: { User: '0:0' } }), stderr: '', exitCode: 0, timedOut: false },
    ]],
    ['SANDBOX_DIAGNOSTIC_FAILED', [
      { stdout: '29', stderr: '', exitCode: 0, timedOut: false },
      { stdout: JSON.stringify({ Id: DIGEST, Architecture: 'arm64', Config: { User: '65532:65532' } }), stderr: '', exitCode: 0, timedOut: false },
      { stdout: 'NETWORK_OR_WRITE_SUCCEEDED', stderr: '', exitCode: 42, timedOut: false },
    ]],
    ['SANDBOX_DIAGNOSTIC_TIMEOUT', [
      { stdout: '29', stderr: '', exitCode: 0, timedOut: false },
      { stdout: JSON.stringify({ Id: DIGEST, Architecture: 'arm64', Config: { User: '65532:65532' } }), stderr: '', exitCode: 0, timedOut: false },
      { stdout: '', stderr: '', exitCode: null, timedOut: true },
    ]],
  ] as const)('fails closed with %s', async (reasonCode, values) => {
    const execute = jest.fn();
    for (const value of values) execute.mockResolvedValueOnce(value);
    await expect(new DockerExternalGuardDogRunner(policy, execute).preflight('/host/package'))
      .resolves.toMatchObject({ verified: false, reasonCode });
  });

  it('maps and redacts host paths while preserving GuardDog JSON', async () => {
    const stdout = JSON.stringify({
      package: '/analysis/package', results: { rule: [{ location: '/analysis/package/index.js:1' }] },
    });
    const execute = jest.fn().mockResolvedValue({ stdout, stderr: '/host/package warning', exitCode: 0, timedOut: false });
    const actual = await new DockerExternalGuardDogRunner(policy, execute).run(request());
    expect(actual.stdout).toContain('index.js:1');
    expect(actual.stdout).not.toContain('/analysis/package');
    expect(actual.stderr).toBe('<PACKAGE_ROOT> warning');
    expect(actual.command.join(' ')).not.toContain('/host/package');
    expect(execute.mock.calls[0]?.[1]).toContain('--no-sandbox');
  });

  it('reports timeout and non-zero exit without retry', async () => {
    const execute = jest.fn().mockResolvedValue({ stdout: '', stderr: 'timeout', exitCode: null, timedOut: true });
    const actual = await new DockerExternalGuardDogRunner(policy, execute).run(request());
    expect(actual).toMatchObject({ timedOut: true, exitCode: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
