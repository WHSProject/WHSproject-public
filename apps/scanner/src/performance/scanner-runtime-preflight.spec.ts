import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyScannerRuntime } from './scanner-runtime-preflight';

const requiredNodeRange = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')).engines.node as string;
const runtime = {
  nodeVersion: 'v24.18.0', nodeExecutable: '/fixture/node', platform: 'darwin', architecture: 'arm64',
  execArgv: ['--no-node-snapshot'], nodeOptions: '',
};
const native = { version: 'fixture', smokePassed: true as const };

describe('Scanner pilot runtime preflight (#416)', () => {
  it('records runtime provenance without copying arbitrary environment options', () => {
    const probe = jest.fn().mockReturnValue(native);
    expect(verifyScannerRuntime(requiredNodeRange, { ...runtime, nodeOptions: '--max-old-space-size=1024' }, probe))
      .toEqual({ nodeVersion: runtime.nodeVersion, nodeExecutable: runtime.nodeExecutable, platform: runtime.platform,
        architecture: runtime.architecture, requiredNodeRange, noNodeSnapshot: true, native });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each(['v22.0.0', 'v25.0.0', 'v26.5.0', 'not-a-version'])('rejects unsupported %s before loading native code', (nodeVersion) => {
    const probe = jest.fn();
    expect(() => verifyScannerRuntime(requiredNodeRange, { ...runtime, nodeVersion }, probe)).toThrow('SCANNER_NODE_UNSUPPORTED');
    expect(probe).not.toHaveBeenCalled();
  });

  it('uses the supplied manifest range rather than a duplicated Node major constant', () => {
    expect(() => verifyScannerRuntime('>=26 <27', runtime, () => native)).toThrow('SCANNER_NODE_UNSUPPORTED');
  });

  it.each(['', 'not-a-range'])('rejects an invalid/empty manifest range: %s', (range) => {
    expect(() => verifyScannerRuntime(range, runtime, () => native)).toThrow('SCANNER_RUNTIME_RANGE_INVALID');
  });

  it.each([
    { execArgv: [], nodeOptions: '' },
    { execArgv: ['--no-node-snapshot', '--node-snapshot'], nodeOptions: '' },
    { execArgv: [], nodeOptions: '--no-node-snapshot-other' },
  ])('rejects missing/conflicting snapshot flags before loading native code: %j', (flags) => {
    const probe = jest.fn();
    expect(() => verifyScannerRuntime(requiredNodeRange, { ...runtime, ...flags }, probe)).toThrow('SCANNER_NODE_SNAPSHOT_FLAG_REQUIRED');
    expect(probe).not.toHaveBeenCalled();
  });

  it('accepts the required flag in NODE_OPTIONS', () => {
    expect(verifyScannerRuntime(requiredNodeRange, { ...runtime, execArgv: [], nodeOptions: '--no-node-snapshot' }, () => native).noNodeSnapshot).toBe(true);
  });

  it('reports native load failure explicitly and retains the underlying cause', () => {
    const cause = new Error('fixture ABI mismatch');
    expect(() => verifyScannerRuntime(requiredNodeRange, runtime, () => { throw cause; }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining('SCANNER_NATIVE_PREFLIGHT_FAILED'), cause }));
  });

  it('loads the installed native sandbox and evaluates only an authored constant', () => {
    expect(verifyScannerRuntime(requiredNodeRange).native).toEqual({ version: expect.any(String), smokePassed: true });
  });
});
