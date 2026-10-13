import { createRequire } from 'node:module';
import { satisfies, validRange } from 'semver';

interface RuntimeEnvironment {
  nodeVersion: string;
  nodeExecutable: string;
  platform: string;
  architecture: string;
  execArgv: readonly string[];
  nodeOptions: string;
}

interface NativeProbeResult { version: string; smokePassed: true }

/** Loads the same native dependency as webcrack; never evaluates package code. */
export function probeNativeSandbox(): NativeProbeResult {
  const scannerRequire = createRequire(__filename);
  const webcrackRequire = createRequire(scannerRequire.resolve('webcrack'));
  const { Isolate } = webcrackRequire('isolated-vm') as {
    Isolate: new (options: { memoryLimit: number }) => {
      createContextSync(): { evalSync(code: string, options: { timeout: number }): unknown; release(): void };
      dispose(): void;
    };
  };
  const { version } = webcrackRequire('isolated-vm/package.json') as { version: string };
  const isolate = new Isolate({ memoryLimit: 8 });
  try {
    const context = isolate.createContextSync();
    try {
      if (context.evalSync('1 + 1', { timeout: 1_000 }) !== 2) throw new Error('Native sandbox smoke mismatch');
    } finally { context.release(); }
  } finally { isolate.dispose(); }
  return { version, smokePassed: true };
}

/** Pilot-only guard. Fail before corpus extraction, Docker calls, or measurements. */
export function verifyScannerRuntime(
  requiredNodeRange: string,
  runtime: RuntimeEnvironment = {
    nodeVersion: process.version, nodeExecutable: process.execPath,
    platform: process.platform, architecture: process.arch,
    execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '',
  },
  nativeProbe: () => NativeProbeResult = probeNativeSandbox,
) {
  if (typeof requiredNodeRange !== 'string' || requiredNodeRange.trim() === '' || validRange(requiredNodeRange) === null) {
    throw new Error('SCANNER_RUNTIME_RANGE_INVALID: check package.json engines.node');
  }
  if (!satisfies(runtime.nodeVersion, requiredNodeRange)) {
    throw new Error(`SCANNER_NODE_UNSUPPORTED: ${runtime.nodeVersion}; expected ${requiredNodeRange}`);
  }
  const flags = [...runtime.execArgv, ...runtime.nodeOptions.split(/\s+/u)];
  if (!flags.includes('--no-node-snapshot') || flags.includes('--node-snapshot')) {
    throw new Error('SCANNER_NODE_SNAPSHOT_FLAG_REQUIRED: launch node --no-node-snapshot');
  }
  let native: NativeProbeResult;
  try { native = nativeProbe(); }
  catch (error) {
    throw new Error('SCANNER_NATIVE_PREFLIGHT_FAILED: verify webcrack/isolated-vm for the supported Node runtime', { cause: error });
  }
  return {
    nodeVersion: runtime.nodeVersion, nodeExecutable: runtime.nodeExecutable,
    platform: runtime.platform, architecture: runtime.architecture,
    requiredNodeRange, noNodeSnapshot: true, native,
  };
}
