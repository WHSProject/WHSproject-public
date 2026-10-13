'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { verifyTarball } = require('../src/verify-tarball');

const VERIFY_CACHE_SCRIPT = path.resolve(
  __dirname,
  '../../../scripts/verify-cache.sh',
);
const SCRIPT_ROOT = 'const ROOT = "/verdaccio/storage/data";';
const EMBEDDED_SOURCE_START = " -e '\n";
const EMBEDDED_SOURCE_END = '\n\' -- "${MODE}" "${VOLUME}"';

function sriOf(contents) {
  return `sha512-${crypto.createHash('sha512').update(contents).digest('base64')}`;
}

function shasumOf(contents) {
  return crypto.createHash('sha1').update(contents).digest('hex');
}

function createFixture({
  packageName,
  version,
  filename,
  expectedContents,
  storedContents,
  reference = 'integrity',
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whs-integrity-compat-'));
  const packageDir = packageName.startsWith('@')
    ? path.join(root, ...packageName.split('/'))
    : path.join(root, packageName);
  const dist = {
    tarball: `https://registry.npmjs.org/${packageName}/-/${filename}`,
  };

  if (reference === 'integrity') {
    dist.integrity = sriOf(expectedContents);
  } else if (reference === 'shasum') {
    dist.shasum = shasumOf(expectedContents);
  }

  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      versions: {
        [version]: {
          version,
          dist,
        },
      },
    }),
  );
  fs.writeFileSync(path.join(packageDir, filename), storedContents);

  return { packageDir, root };
}

function createFileStorage(fixture) {
  return {
    getPackage({ callback }) {
      fs.readFile(path.join(fixture.packageDir, 'package.json'), 'utf8', (error, value) => {
        if (error) {
          callback(error);
          return;
        }

        try {
          callback(null, JSON.parse(value));
        } catch (parseError) {
          callback(parseError);
        }
      });
    },
    getTarball(_packageName, filename) {
      return fs.createReadStream(path.join(fixture.packageDir, filename));
    },
    async hasLocalTarball(_packageName, filename) {
      return fs.existsSync(path.join(fixture.packageDir, filename));
    },
  };
}

function readEmbeddedVerifier(storageRoot) {
  const shellSource = fs.readFileSync(VERIFY_CACHE_SCRIPT, 'utf8');
  const start = shellSource.indexOf(EMBEDDED_SOURCE_START);
  const end = shellSource.lastIndexOf(EMBEDDED_SOURCE_END);

  assert.notEqual(start, -1, 'verify-cache.sh의 Node 검사 코드 시작점을 찾지 못했습니다');
  assert.notEqual(end, -1, 'verify-cache.sh의 Node 검사 코드 끝점을 찾지 못했습니다');

  const source = shellSource.slice(start + EMBEDDED_SOURCE_START.length, end);
  assert.match(source, /const ROOT = "\/verdaccio\/storage\/data";/);

  return source.replace(SCRIPT_ROOT, `const ROOT = ${JSON.stringify(storageRoot)};`);
}

function runVerifyCacheScript(storageRoot) {
  const result = spawnSync(
    process.execPath,
    ['-e', readEmbeddedVerifier(storageRoot), 'normal', 'compat-fixture'],
    { encoding: 'utf8' },
  );
  const match = result.stdout.match(/^Result: (PASS|FAIL|UNVERIFIABLE|NO_TARGET)$/m);

  assert.ok(match, `verify-cache.sh 판정을 읽지 못했습니다:\n${result.stdout}\n${result.stderr}`);
  return match[1];
}

test('verify-cache.sh and verifyTarball agree on shared fixtures', async (t) => {
  const original = Buffer.from('original tarball bytes');
  const changed = Buffer.from('changed tarball bytes');
  const cases = [
    {
      name: 'normal tarball',
      packageName: 'is-number',
      version: '7.0.0',
      filename: 'is-number-7.0.0.tgz',
      expectedContents: original,
      storedContents: original,
      expectedStatus: 'PASS',
    },
    {
      name: 'tampered tarball',
      packageName: 'is-number',
      version: '7.0.0',
      filename: 'is-number-7.0.0.tgz',
      expectedContents: original,
      storedContents: changed,
      expectedStatus: 'FAIL',
    },
    {
      name: 'scoped package',
      packageName: '@whs/example',
      version: '1.0.0',
      filename: 'example-1.0.0.tgz',
      expectedContents: original,
      storedContents: original,
      expectedStatus: 'PASS',
    },
    {
      name: 'legacy shasum',
      packageName: 'legacy-package',
      version: '1.0.0',
      filename: 'legacy-package-1.0.0.tgz',
      expectedContents: original,
      storedContents: original,
      reference: 'shasum',
      expectedStatus: 'PASS',
    },
    {
      name: 'missing reference hash',
      packageName: 'no-reference',
      version: '1.0.0',
      filename: 'no-reference-1.0.0.tgz',
      expectedContents: original,
      storedContents: original,
      reference: 'missing',
      expectedStatus: 'UNVERIFIABLE',
    },
  ];

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = createFixture(fixtureCase);

      try {
        const nodeResult = await verifyTarball(createFileStorage(fixture), {
          packageName: fixtureCase.packageName,
          version: fixtureCase.version,
        });
        const scriptResult = runVerifyCacheScript(fixture.root);

        assert.equal(nodeResult.status, fixtureCase.expectedStatus);
        assert.equal(scriptResult, fixtureCase.expectedStatus);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});
