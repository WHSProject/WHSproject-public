'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  formatSri,
  hashStream,
  normalizeDigest,
  parseSri,
  selectStrongest,
} = require('../src/sri');

test('parses a single SRI entry', () => {
  assert.deepEqual(parseSri('sha512-abc123'), [
    { algorithm: 'sha512', digest: 'abc123' },
  ]);
});

test('parses several space separated entries', () => {
  assert.deepEqual(parseSri('sha256-aaa  sha512-bbb'), [
    { algorithm: 'sha256', digest: 'aaa' },
    { algorithm: 'sha512', digest: 'bbb' },
  ]);
});

test('drops tokens that are not in SRI shape', () => {
  assert.deepEqual(parseSri('sha512'), []);
  assert.deepEqual(parseSri('-abc'), []);
  assert.deepEqual(parseSri('sha512-'), []);
  assert.deepEqual(parseSri(''), []);
  assert.deepEqual(parseSri('   '), []);
  assert.deepEqual(parseSri(undefined), []);
  assert.deepEqual(parseSri(42), []);
});

test('keeps base64 padding inside the digest', () => {
  assert.deepEqual(parseSri('sha512-Zm9v=='), [
    { algorithm: 'sha512', digest: 'Zm9v==' },
  ]);
});

test('normalizes base64 padding so equal hashes compare equal', () => {
  const digest = crypto.createHash('sha512').update('bytes').digest('base64');
  const unpadded = digest.replace(/=+$/, '');

  assert.notEqual(unpadded, digest);
  assert.equal(normalizeDigest(unpadded), digest);
  assert.equal(normalizeDigest(digest), digest);
});

test('picks the strongest algorithm that is present', () => {
  const entries = parseSri('sha256-aaa sha512-bbb sha384-ccc');

  assert.deepEqual(selectStrongest(entries), {
    algorithm: 'sha512',
    digests: ['bbb'],
  });
});

test('keeps every digest of the chosen algorithm', () => {
  const entries = parseSri('sha512-aaa sha512-bbb sha256-ccc');

  assert.deepEqual(selectStrongest(entries), {
    algorithm: 'sha512',
    digests: ['aaa', 'bbb'],
  });
});

test('returns nothing when no known algorithm is present', () => {
  assert.equal(selectStrongest(parseSri('md5-aaa')), undefined);
  assert.equal(selectStrongest([]), undefined);
});

test('formats digests back into an SRI string', () => {
  assert.equal(formatSri('sha512', ['aaa']), 'sha512-aaa');
  assert.equal(formatSri('sha512', ['aaa', 'bbb']), 'sha512-aaa sha512-bbb');
});

test('hashes a stream in chunks', async () => {
  const payload = Buffer.from('tarball-bytes');
  const expected = crypto.createHash('sha512').update(payload).digest('base64');

  const digest = await hashStream(
    Readable.from([payload.subarray(0, 4), payload.subarray(4)]),
    'sha512',
    'base64',
  );

  assert.equal(digest, expected);
});

test('rejects when the stream fails', async () => {
  const stream = Readable.from(
    (async function* failingStream() {
      yield Buffer.from('partial');
      throw new Error('read failed');
    })(),
  );

  await assert.rejects(hashStream(stream, 'sha512', 'base64'), /read failed/);
});

test('rejects an algorithm that node does not support', async () => {
  await assert.rejects(
    hashStream(Readable.from([Buffer.from('x')]), 'not-a-hash', 'base64'),
    /Digest method not supported|not-a-hash/,
  );
});

test('does not hold the whole stream in memory', async () => {
  // 10MB 를 흘려보내되 한 번에 들고 있는 Chunk 는 64KB 다.
  const chunk = Buffer.alloc(64 * 1024, 7);
  const chunkCount = 160;
  const hash = crypto.createHash('sha512');
  for (let index = 0; index < chunkCount; index += 1) {
    hash.update(chunk);
  }

  let produced = 0;
  const stream = Readable.from(
    (function* largeStream() {
      for (let index = 0; index < chunkCount; index += 1) {
        produced += 1;
        yield chunk;
      }
    })(),
  );

  const digest = await hashStream(stream, 'sha512', 'base64');

  assert.equal(digest, hash.digest('base64'));
  assert.equal(produced, chunkCount);
});
