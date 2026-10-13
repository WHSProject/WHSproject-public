'use strict';

const crypto = require('node:crypto');

// 앞쪽이 더 강한 알고리즘이다. SRI 는 여러 알고리즘이 함께 있으면 가장 강한 것으로
// 검증한다. 약한 알고리즘이 맞았다고 통과시키면 강한 쪽 불일치를 놓친다.
// verify-cache.sh 와 같은 순서를 쓴다.
const ALGORITHM_STRENGTH = Object.freeze(['sha512', 'sha384', 'sha256']);
const SUPPORTED_ALGORITHMS = new Set(ALGORITHM_STRENGTH);

// 알고리즘별 digest 길이(byte). 값이 이 길이와 다르면 잘린 값이거나 다른 알고리즘의
// digest 다. 그대로 비교하면 "값이 달라서 불일치" 로 판정되어, 손상된 Metadata 가
// 변조된 Tarball 처럼 보인다.
const DIGEST_BYTES = Object.freeze({ sha256: 32, sha384: 48, sha512: 64 });

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/i;

function isValidDigest(algorithm, digest) {
  const expectedBytes = DIGEST_BYTES[algorithm];
  if (expectedBytes === undefined || !BASE64.test(digest)) {
    return false;
  }

  return Buffer.from(digest, 'base64').length === expectedBytes;
}

// base64 는 같은 byte 를 여러 문자열로 적을 수 있다. npm Metadata 에는 padding 이
// 빠진 digest 가 들어오기도 하는데, Node 의 hash.digest('base64') 는 언제나 padding 을
// 붙인다. 문자열을 그대로 비교하면 같은 해시가 불일치로 판정되므로, 비교 전에 한 번
// decode 했다가 다시 encode 해 같은 표기로 맞춘다.
function normalizeDigest(digest) {
  return Buffer.from(digest, 'base64').toString('base64');
}

function isValidShasum(value) {
  return typeof value === 'string' && SHA1_HEX.test(value.trim());
}

// dist.integrity 는 SRI 형식이다: "<alg>-<base64>". 공백으로 여러 개가 올 수 있다.
function parseSri(value) {
  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return [];
  }

  return trimmed
    .split(/\s+/)
    .map((token) => {
      const dash = token.indexOf('-');
      if (dash < 1 || dash === token.length - 1) {
        return undefined;
      }

      return { algorithm: token.slice(0, dash), digest: token.slice(dash + 1) };
    })
    .filter((entry) => entry !== undefined);
}

// 검증에 쓸 알고리즘 하나와 그 알고리즘의 기대 digest 들을 고른다.
// 같은 알고리즘의 digest 가 여러 개면 그중 하나만 맞아도 유효하다(W3C SRI).
function selectStrongest(entries) {
  const algorithm = ALGORITHM_STRENGTH.find((candidate) =>
    entries.some((entry) => entry.algorithm === candidate),
  );

  if (algorithm === undefined) {
    return undefined;
  }

  return {
    algorithm,
    digests: entries
      .filter((entry) => entry.algorithm === algorithm)
      .map((entry) => entry.digest),
  };
}

function formatSri(algorithm, digests) {
  return digests.map((digest) => `${algorithm}-${digest}`).join(' ');
}

// Stream 으로 읽어 해시를 계산한다. 파일 전체를 Memory 에 올리지 않으므로
// Tarball 이 커도 사용량이 파일 크기를 따라가지 않는다.
function hashStream(stream, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    let hash;
    try {
      hash = crypto.createHash(algorithm);
    } catch (error) {
      stream.destroy?.();
      reject(error);
      return;
    }

    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      // 중간에 끊긴 Stream 을 남겨 두면 파일 Handle 이 열린 채로 쌓인다.
      stream.destroy?.();
      reject(error);
    };

    stream.on('error', fail);
    stream.on('data', (chunk) => {
      try {
        hash.update(chunk);
      } catch (error) {
        fail(error);
      }
    });
    stream.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        resolve(hash.digest(encoding));
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  ALGORITHM_STRENGTH,
  DIGEST_BYTES,
  SUPPORTED_ALGORITHMS,
  formatSri,
  hashStream,
  isValidDigest,
  isValidShasum,
  normalizeDigest,
  parseSri,
  selectStrongest,
};
