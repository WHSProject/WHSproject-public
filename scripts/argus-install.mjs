import { spawn } from 'node:child_process';

const DEFAULT_GATEWAY_URL = 'http://localhost:3000';

function usage() {
  console.log(`
Usage:
  node scripts/argus-install.mjs <package-spec> [npm install options]

Examples:
  node scripts/argus-install.mjs express
  node scripts/argus-install.mjs express@5.1.0
  node scripts/argus-install.mjs @babel/core@7.25.0
  node scripts/argus-install.mjs lodash --save-dev

Environment:
  ARGUS_GATEWAY_URL   Gateway base URL
                      default: ${DEFAULT_GATEWAY_URL}
`);
}

function packageNameFromSpec(spec) {
  if (!spec || spec.startsWith('-')) {
    throw new Error('a package spec is required');
  }

  if (
    spec.startsWith('http:')
    || spec.startsWith('https:')
    || spec.startsWith('git:')
    || spec.startsWith('git+')
    || spec.startsWith('file:')
    || spec.startsWith('./')
    || spec.startsWith('../')
    || spec.startsWith('/')
  ) {
    throw new Error(
      `unsupported package spec for Root tracking MVP: ${spec}`,
    );
  }

  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/');

    if (slashIndex <= 1) {
      throw new Error(`invalid scoped package spec: ${spec}`);
    }

    const versionIndex = spec.indexOf('@', slashIndex + 1);

    return versionIndex === -1
      ? spec
      : spec.slice(0, versionIndex);
  }

  const versionIndex = spec.indexOf('@');

  return versionIndex <= 0
    ? spec
    : spec.slice(0, versionIndex);
}

async function registerRootIntent(gatewayUrl, packageName) {
  const baseUrl = gatewayUrl.replace(/\/+$/, '');

  const response = await fetch(
    `${baseUrl}/internal/v1/install-intents`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ packageName }),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `failed to register Root intent: HTTP ${response.status}`
      + (body ? ` ${body}` : ''),
    );
  }
}

function runNpmInstall(registryUrl, packageSpec, npmArgs) {
  const command = process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm';

  const args = [
    'install',
    packageSpec,
    ...npmArgs,
    `--registry=${registryUrl}`,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.once('error', reject);

    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`npm install terminated by signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return;
  }

  const [packageSpec, ...npmArgs] = args;
  const packageName = packageNameFromSpec(packageSpec);

  const gatewayUrl =
    process.env.ARGUS_GATEWAY_URL?.trim()
    || DEFAULT_GATEWAY_URL;

  const registryUrl =
    `${gatewayUrl.replace(/\/+$/, '')}/npm/`;

  console.log(`[argus] root package: ${packageName}`);
  console.log(`[argus] gateway: ${gatewayUrl}`);

  await registerRootIntent(gatewayUrl, packageName);

  console.log('[argus] root install intent registered');
  console.log(`[argus] npm registry: ${registryUrl}`);

  const exitCode = await runNpmInstall(
    registryUrl,
    packageSpec,
    npmArgs,
  );

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(
    `[argus] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
