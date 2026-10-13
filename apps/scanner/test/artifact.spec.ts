import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SafeExtractor } from '../src/artifact/extractor/safe-extractor';
import { ArtifactHasher } from '../src/artifact/hasher/artifact-hasher';
import { PackageIdentityVerifier } from '../src/artifact/identity/package-identity-verifier';
import { IntegrityVerifier } from '../src/artifact/integrity/integrity-verifier';

function tarEntry(name: string, content: Buffer, type = '0', linkName = ''): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

function tarball(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

describe('Scanner artifact processing', () => {
  it('verifies SRI by digest and returns the artifact SHA-256', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-integrity-'));
    const artifactPath = join(root, 'artifact.tgz');
    const payload = Buffer.from('verified-artifact');
    await writeFile(artifactPath, payload);
    const integrity = `sha512-${createHash('sha512').update(payload).digest('base64')}`;

    const result = await new IntegrityVerifier().verify(artifactPath, {
      registryIntegrity: integrity,
      expectedIntegrity: integrity,
    });

    expect(result.verified).toBe(true);
    expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    await expect(new IntegrityVerifier().verify(artifactPath, {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      stage: 'INTEGRITY_VERIFICATION',
      retryable: false,
    });
    await expect(
      new IntegrityVerifier().verify(artifactPath, { registryIntegrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' }),
    ).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' });
  });

  it('extracts only verified regular files and rejects traversal and links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-extractor-'));
    const artifactPath = join(root, 'artifact.tgz');
    await writeFile(
      artifactPath,
      tarball([
        tarEntry('package/package.json', Buffer.from('{"name":"fixture"}')),
        tarEntry('package/index.js', Buffer.from('module.exports = 1;')),
      ]),
    );
    const extractedPath = join(root, 'extracted');
    const integrity = { verified: true as const };

    const result = await new SafeExtractor().extract({
      artifactPath,
      extractedPath,
      integrity,
      maxExtractedFiles: 2,
    });

    expect(result.files).toBe(2);
    expect(await readFile(join(extractedPath, 'package', 'package.json'), 'utf8')).toContain('fixture');

    const traversalPath = join(root, 'traversal.tgz');
    await writeFile(traversalPath, tarball([tarEntry('../escape.txt', Buffer.from('nope'))]));
    await expect(new SafeExtractor().extract({
      artifactPath: traversalPath,
      extractedPath: join(root, 'traversal-out'),
      integrity,
    })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });

    const linkPath = join(root, 'link.tgz');
    await writeFile(linkPath, tarball([tarEntry('package/link', Buffer.alloc(0), '2', '../../outside')]));
    await expect(new SafeExtractor().extract({
      artifactPath: linkPath,
      extractedPath: join(root, 'link-out'),
      integrity,
    })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
    await expect(stat(join(root, 'link-out'))).rejects.toBeDefined();

    const hardLinkPath = join(root, 'hard-link.tgz');
    await writeFile(hardLinkPath, tarball([
      tarEntry('package/hard-link', Buffer.alloc(0), '1', '../../outside'),
    ]));
    await expect(new SafeExtractor().extract({
      artifactPath: hardLinkPath,
      extractedPath: join(root, 'hard-link-out'),
      integrity,
    })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
    await expect(stat(join(root, 'hard-link-out'))).rejects.toBeDefined();
  });

  it.each([
    ['corrupted archive', Buffer.from('not a gzip archive'), {}],
    ['file count limit', tarball([
      tarEntry('package/one.js', Buffer.from('one')),
      tarEntry('package/two.js', Buffer.from('two')),
    ]), { maxExtractedFiles: 1 }],
    ['extracted byte limit', tarball([
      tarEntry('package/large.js', Buffer.from('large')),
    ]), { maxExtractedBytes: 4 }],
    ['path depth limit', tarball([
      tarEntry('package/deep/file.js', Buffer.from('deep')),
    ]), { maxPathDepth: 2 }],
  ] as const)('rejects %s during safe extraction', async (caseName, payload, limits) => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-extractor-boundary-'));
    const artifactPath = join(root, `${caseName.replaceAll(' ', '-')}.tgz`);
    const extractedPath = join(root, 'extracted');
    await writeFile(artifactPath, payload);

    await expect(new SafeExtractor().extract({
      artifactPath,
      extractedPath,
      integrity: { verified: true },
      ...limits,
    })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' });
    await expect(stat(extractedPath)).rejects.toBeDefined();
  });

  it('hashes the tarball with SHA-256 and verifies package identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-hash-identity-'));
    const artifactPath = join(root, 'artifact.tgz');
    const payload = Buffer.from('hash-me');
    await writeFile(artifactPath, payload);

    await expect(new ArtifactHasher().hash(artifactPath))
      .resolves.toBe(createHash('sha256').update(payload).digest('hex'));

    const extractedPath = join(root, 'extracted');
    await mkdir(join(extractedPath, 'package'), { recursive: true });
    await writeFile(join(extractedPath, 'package', 'package.json'), JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: { postinstall: 'node should-not-run.js' },
    }));

    await expect(new PackageIdentityVerifier().verify(extractedPath, {
      name: 'fixture',
      version: '1.0.0',
    })).resolves.toMatchObject({ name: 'fixture', version: '1.0.0' });

    await expect(new PackageIdentityVerifier().verify(extractedPath, {
      name: 'other',
      version: '1.0.0',
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });

  it('verifies source Fixture identity and rejects the mismatch Fixture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scanner-fixture-identity-'));
    const extractedPath = join(root, 'extracted');
    const normalPackage = await readFile(join(
      __dirname,
      'fixtures/npm/normal-unscoped/package/package.json',
    ), 'utf8');
    const scopedPackage = await readFile(join(
      __dirname,
      'fixtures/npm/normal-scoped/package/package.json',
    ), 'utf8');
    const mismatchPackage = await readFile(join(
      __dirname,
      'fixtures/npm/identity-mismatch/package/package.json',
    ), 'utf8');
    await mkdir(join(extractedPath, 'package'), { recursive: true });

    await writeFile(join(extractedPath, 'package', 'package.json'), scopedPackage);
    await expect(new PackageIdentityVerifier().verify(extractedPath, {
      name: '@fixture/normal-scoped',
      version: '1.0.0',
    })).resolves.toMatchObject({
      name: '@fixture/normal-scoped',
      version: '1.0.0',
    });

    await writeFile(join(extractedPath, 'package', 'package.json'), normalPackage);
    await expect(new PackageIdentityVerifier().verify(extractedPath, {
      name: 'fixture-normal-unscoped',
      version: '1.0.0',
    })).resolves.toMatchObject({
      name: 'fixture-normal-unscoped',
      version: '1.0.0',
    });

    await writeFile(join(extractedPath, 'package', 'package.json'), mismatchPackage);
    await expect(new PackageIdentityVerifier().verify(extractedPath, {
      name: 'fixture-requested-identity',
      version: '1.0.0',
    })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
  });
});
