import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { extractZipCodeOnly } from './tier2-omcbench-archive.mjs';

test('extracts stored and deflated code entries without an external unzip executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
  try {
    const archivePath = join(root, 'fixture.zip');
    const extractedPath = join(root, 'extracted');
    await mkdir(extractedPath);
    await writeFile(archivePath, makeZip([
      ['package/package.json', Buffer.from('{"name":"fixture"}'), 0],
      ['package/index.js', Buffer.from('module.exports = 1;'), 8],
    ]));

    const result = await extractZipCodeOnly(archivePath, extractedPath);

    assert.deepEqual(result, {
      files: ['package/package.json', 'package/index.js'],
      skippedLargeFiles: 0,
    });
    assert.equal(await readFile(join(extractedPath, 'package/index.js'), 'utf8'), 'module.exports = 1;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('skips traversal entries while extracting safe code entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
  try {
    const archivePath = join(root, 'fixture.zip');
    const extractedPath = join(root, 'extracted');
    await mkdir(extractedPath);
    await writeFile(archivePath, makeZip([
      ['../outside.js', Buffer.from('not written'), 0],
      ['package/index.js', Buffer.from('module.exports = 1;'), 0],
    ]));

    const result = await extractZipCodeOnly(archivePath, extractedPath);

    assert.deepEqual(result.files, ['package/index.js']);
    assert.equal(await readFile(join(extractedPath, 'package/index.js'), 'utf8'), 'module.exports = 1;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed, invalid-offset, and unsupported-compression archives', async () => {
  const cases = [
    ['truncated archive', (archive) => archive.subarray(0, -1)],
    ['invalid local offset', (archive) => {
      const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      archive.writeUInt32LE(0xfffffff0, centralOffset + 42);
      return archive;
    }],
    ['unsupported compression', () => makeZip([
      ['package/index.js', Buffer.from('module.exports = 1;'), 12],
    ])],
  ];

  for (const [name, mutate] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
    try {
      const archivePath = join(root, 'fixture.zip');
      const extractedPath = join(root, 'extracted');
      await mkdir(extractedPath);
      const archive = makeZip([
        ['package/index.js', Buffer.from('module.exports = 1;'), 0],
      ]);
      await writeFile(archivePath, mutate(archive));

      await assert.rejects(
        extractZipCodeOnly(archivePath, extractedPath),
        (error) => error instanceof Error,
        name,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('rejects duplicate normalized output paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
  try {
    const archivePath = join(root, 'fixture.zip');
    const extractedPath = join(root, 'extracted');
    await mkdir(extractedPath);
    await writeFile(archivePath, makeZip([
      ['package/index.js', Buffer.from('first'), 0],
      ['package/./index.js', Buffer.from('second'), 0],
    ]));

    await assert.rejects(
      extractZipCodeOnly(archivePath, extractedPath),
      /duplicate normalized output path/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects Central Directory and Local Header metadata mismatches', async () => {
  const cases = [
    ['filename', (archive) => { archive[30] = 'x'.charCodeAt(0); return archive; }],
    ['compression method', (archive) => { archive.writeUInt16LE(8, 8); return archive; }],
  ];
  for (const [name, mutate] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
    try {
      const archivePath = join(root, 'fixture.zip');
      const extractedPath = join(root, 'extracted');
      await mkdir(extractedPath);
      const archive = makeZip([
        ['package/index.js', Buffer.from('module.exports = 1;'), 0],
      ]);
      mutate(archive);
      await writeFile(archivePath, archive);

      await assert.rejects(
        extractZipCodeOnly(archivePath, extractedPath),
        /zip local (filename|compression) mismatch/u,
        name,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('skips explicit directory entries without writing them as files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tier2-omcbench-zip-test-'));
  try {
    const archivePath = join(root, 'fixture.zip');
    const extractedPath = join(root, 'extracted');
    await mkdir(extractedPath);
    await writeFile(archivePath, makeZip([
      { name: 'package.json', content: Buffer.alloc(0), compression: 0, externalAttributes: 0x10 },
    ]));

    const result = await extractZipCodeOnly(archivePath, extractedPath);

    assert.deepEqual(result.files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const item of entries) {
    const [name, content, compression] = Array.isArray(item)
      ? item
      : [item.name, item.content, item.compression];
    const externalAttributes = Array.isArray(item) ? 0 : (item.externalAttributes ?? 0);
    const nameBytes = Buffer.from(name);
    const compressed = compression === 8 ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}
