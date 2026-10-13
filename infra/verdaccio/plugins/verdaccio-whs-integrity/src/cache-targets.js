'use strict';

const { createRequire } = require('node:module');

const {
  isSafePackageName,
  isSafeTarballName,
  readLocalPackument,
  readTarballName,
} = require('./verify-tarball');

class CacheListingUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CacheListingUnavailableError';
  }
}

// 캐시된 Package 목록을 주는 공식 API 가 없다. storage.getLocalDatabase 는 publish 한
// Package 만 돌려주고, Uplink 에서 받아 저장한 Package 는 빠진다(실측).
//
// 그래서 저장소 종류별로 목록을 뽑는 방법을 따로 둔다. 여기 없는 저장소는 정기 검사를
// 끈다. 일부만 검사하고 정상처럼 보고하는 것보다 꺼져 있다고 알리는 편이 낫다.
// 새 저장소를 지원하려면 이 목록에 항목을 하나 추가한다.
const CACHE_LISTERS = Object.freeze([
  Object.freeze({
    // Verdaccio 기본 로컬 저장소. Storage Plugin 의 search 가 저장 폴더를 직접 훑어
    // 캐시된 Package 와 @scope/name 까지 돌려준다(실측). storage.localStorage 는
    // Verdaccio 내부 속성이라 업그레이드로 없어질 수 있다.
    name: 'local-storage',
    matches(storage) {
      const plugin = storagePluginOf(storage);
      return (
        plugin?.constructor?.name === 'LocalDatabase' &&
        typeof plugin.search === 'function'
      );
    },
    listNames(storage) {
      return listBySearch(storagePluginOf(storage));
    },
  }),
  Object.freeze({
    // verdaccio-aws-s3-storage. 이 Plugin 의 search 는 publish 목록
    // (verdaccio-s3-db.json)만 돌려 캐시된 Package 가 빠진다(코드 확인). 그래서 버킷을
    // 직접 조회해 '<keyPrefix><Package 이름>/package.json' 키로 목록을 만든다.
    // Plugin 이 가진 S3 client 와 bucket·keyPrefix 를 그대로 쓰므로 인증 정보를 따로
    // 받지 않는다. s3·config 는 Plugin 내부 속성이라 버전이 바뀌면 다시 확인한다.
    name: 'aws-s3-storage',
    matches(storage) {
      const plugin = storagePluginOf(storage);
      return (
        plugin?.constructor?.name === 'S3Database' &&
        typeof plugin.s3?.send === 'function' &&
        typeof plugin.config?.bucket === 'string' &&
        plugin.config.bucket !== ''
      );
    },
    listNames(storage, options = {}) {
      return listS3PackageNames(storagePluginOf(storage), options);
    },
  }),
]);

function storagePluginOf(storage) {
  return storage?.localStorage?.storagePlugin;
}

const S3_METADATA_FILE = '/package.json';
// 한 번에 받는 키 수. S3 가 허용하는 최대값이다.
const S3_PAGE_SIZE = 1000;

// ListObjectsV2Command 는 S3 Plugin 이 함께 설치한 AWS SDK 에서 가져온다. WHS Plugin 에
// 따로 Dependency 를 두지 않는다. Verdaccio 가 S3 Plugin 을 찾는 방식(Verdaccio 설치
// 위치에서 패키지 이름으로 찾기)과 같은 기준으로 찾는다.
function loadListObjectsCommand() {
  const fromVerdaccio = createRequire(require.main?.filename ?? __filename);
  const pluginEntry = fromVerdaccio.resolve('verdaccio-aws-s3-storage');
  return createRequire(pluginEntry)('@aws-sdk/client-s3').ListObjectsV2Command;
}

async function listS3PackageNames(plugin, { loadListCommand = loadListObjectsCommand } = {}) {
  const ListObjectsV2Command = loadListCommand();
  const bucket = plugin.config.bucket;
  const prefix = typeof plugin.config.keyPrefix === 'string' ? plugin.config.keyPrefix : '';
  const names = [];
  let continuationToken;

  do {
    const response = await plugin.s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: S3_PAGE_SIZE,
      ContinuationToken: continuationToken,
    }));

    for (const object of response?.Contents ?? []) {
      const name = packageNameFromKey(object?.Key, prefix);
      if (name !== undefined) {
        names.push(name);
      }
    }

    continuationToken = response?.IsTruncated === true ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return names;
}

// 'verdaccio/@scope/name/package.json' -> '@scope/name'. Metadata 키가 아니면 버린다.
// 이름이 안전한지는 listCachedTargets 가 로컬 저장소와 같은 기준으로 다시 본다.
function packageNameFromKey(key, prefix) {
  if (typeof key !== 'string' || !key.startsWith(prefix) || !key.endsWith(S3_METADATA_FILE)) {
    return undefined;
  }
  const name = key.slice(prefix.length, key.length - S3_METADATA_FILE.length);
  return name === '' ? undefined : name;
}

// 경고에 남길 저장소 이름. Class 이름이라 민감정보가 아니다.
function describeStoragePlugin(storage) {
  const name = storagePluginOf(storage)?.constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'unknown';
}

function selectCacheLister(storage) {
  return CACHE_LISTERS.find((lister) => lister.matches(storage));
}

function canListCachedPackages(storage) {
  return selectCacheLister(storage) !== undefined;
}

function listBySearch(plugin) {
  return new Promise((resolve, reject) => {
    const names = [];
    try {
      plugin.search(
        (item, done) => {
          if (typeof item?.name === 'string') {
            names.push(item.name);
          }
          done();
        },
        (error) => (error ? reject(error) : resolve(names)),
        () => true,
      );
    } catch (error) {
      reject(error);
    }
  });
}

// 저장된 Tarball 이 실제로 있는 버전만 검사 대상으로 돌려준다.
//
// Metadata 에는 받지 않은 버전까지 모두 들어 있다. 전부 검사하면 "파일 없음" 결과가
// 쏟아지고, 버전마다 Metadata 를 다시 읽어 부하도 커진다. 그래서 Package 마다
// Metadata 를 한 번만 읽고, 버전별로 Tarball 이 있는지만 확인한다.
//
// 목록을 뽑는 방법만 저장소마다 다르다. 이후 과정은 Verdaccio 공식 Storage API 만
// 쓰므로 저장소와 상관없이 같다.
async function listCachedTargets(storage, options = {}) {
  const lister = selectCacheLister(storage);
  if (lister === undefined) {
    throw new CacheListingUnavailableError(
      `storage plugin ${describeStoragePlugin(storage)} cannot list cached packages`,
    );
  }

  // 실행마다 같은 순서로 검사해 로그를 비교하기 쉽게 한다.
  const names = [...new Set(await lister.listNames(storage, options))].sort();
  const targets = [];
  let unreadable = 0;
  let skipped = 0;

  for (const packageName of names) {
    // 폴더 이름에서 온 값이다. Storage 에 넘기기 전에 검사한다.
    if (!isSafePackageName(packageName)) {
      skipped += 1;
      continue;
    }

    let packument;
    try {
      packument = await readLocalPackument(storage, packageName);
    } catch {
      unreadable += 1;
      continue;
    }

    const versions = packument?.versions;
    if (versions === null || typeof versions !== 'object') {
      unreadable += 1;
      continue;
    }

    for (const version of Object.keys(versions)) {
      const filename = readTarballName(versions[version]?.dist?.tarball);
      // 파일명을 모르거나 경로 구분자를 담고 있으면 있는지 확인할 방법이 없다.
      if (filename === undefined || !isSafeTarballName(filename)) {
        continue;
      }

      let present;
      try {
        present = (await storage.hasLocalTarball(packageName, filename)) === true;
      } catch {
        // 있는지 모르면 대상에 넣는다. verifyTarball 이 TARBALL_PRESENCE_UNKNOWN 으로
        // 보고한다. 빼 버리면 저장돼 있는데 검사에서 빠진 대상을 찾을 수 없다.
        present = true;
      }

      if (present) {
        targets.push({ packageName, version });
      }
    }
  }

  return { targets, packages: names.length, unreadable, skipped };
}

module.exports = {
  CACHE_LISTERS,
  CacheListingUnavailableError,
  canListCachedPackages,
  describeStoragePlugin,
  listCachedTargets,
  packageNameFromKey,
  selectCacheLister,
};
