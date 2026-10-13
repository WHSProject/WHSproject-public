'use strict';

const { ACTIONS, RESULTS } = require('./audit-event');

// Storage 와 Uplink 오류는 HTTP Middleware 에서 볼 수 없다. Verdaccio 가 요청을
// 처리하며 내부에서 부르기 때문이다. 그래서 Verdaccio 가 Plugin 에 넘겨주는 storage
// 객체의 저장소 Plugin 과 Uplink 메서드를 감싸 실패만 관측한다.
//
// 감싼 메서드는 결과를 바꾸지 않는다. 오류는 그대로 다시 던지거나 Callback 으로
// 넘기고, Event 기록 실패가 Registry 요청을 막지 않는다.

// 저장소 Plugin 이 Package 하나를 다루려고 돌려주는 객체의 메서드.
// 마지막 인자가 Callback 인 것과 Stream 을 돌려주는 것으로 나뉜다.
const PACKAGE_CALLBACK_METHODS = Object.freeze([
  'readPackage',
  'createPackage',
  'savePackage',
  'updatePackage',
  'deletePackage',
  'removePackage',
]);
const PACKAGE_STREAM_METHODS = Object.freeze(['readTarball', 'writeTarball']);

// Uplink 의 getRemoteMetadata·fetchTarball 은 인자에서 Package 이름을 따로 읽어야 해
// 공용 래퍼를 쓰지 않고 observeUplinks 에서 하나씩 감싼다.

// 캐시에 없는 Package 를 받아오는 흐름에서는 "없음" 이 정상이다. 이것까지 남기면
// 평상시 로그가 없음 으로 가득 차 진짜 오류가 묻힌다.
function isExpectedMiss(error) {
  const status = statusOf(error);
  if (status === 404) {
    return true;
  }
  // AWS SDK 는 name 에, 파일 시스템은 code 에 넣는다. 둘 다 본다.
  const names = [error?.code, error?.name];
  return names.some((value) => value === 'ENOENT' || value === 'NoSuchKey' || value === 'NotFound');
}

function statusOf(error) {
  // Verdaccio 는 Uplink 가 2xx 가 아닌 응답을 주면 500 내부 오류로 감싸고, 실제 상태
  // 코드를 remoteStatus 에 따로 담는다(up-storage.js 실측). remoteStatus 를 먼저 보지
  // 않으면 npmjs 의 503 이 전부 500 server_error 로 뭉개진다.
  const candidates = [
    error?.remoteStatus,
    error?.status,
    error?.statusCode,
    error?.code,
    error?.$metadata?.httpStatusCode,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) {
      return candidate;
    }
  }
  return undefined;
}

// Error 메시지에는 경로·버킷·자격증명이 섞일 수 있어 그대로 남기지 않는다.
// 정해 둔 분류 값만 기록한다.
function reasonOfError(error) {
  const status = statusOf(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  const name = typeof error?.name === 'string' ? error.name : '';

  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission_denied';
  }
  if (name === 'AccessDenied' || name === 'Forbidden' || status === 403) {
    return 'access_denied';
  }
  if (status === 401) {
    return 'unauthorized';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || name === 'TimeoutError') {
    return 'timeout';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'connection_failed';
  }
  if (code === 'ENOSPC') {
    return 'no_space';
  }
  if (code === 'EROFS') {
    return 'read_only';
  }
  if (typeof status === 'number' && status >= 500) {
    return 'server_error';
  }
  if (typeof status === 'number' && status >= 400) {
    return 'client_error';
  }
  return 'unknown_error';
}

// Tarball URL 에서 Package 이름만 뽑는다. 실패하면 생략한다(추측하지 않는다).
function packageNameFromUrl(value) {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return undefined;
  }
  const marker = pathname.indexOf('/-/');
  if (marker <= 0) {
    return undefined;
  }
  // 잘못 인코딩된 경로(%ZZ 등)는 decodeURIComponent 가 예외를 던진다. 이름을 못 읽는
  // 것뿐인데 여기서 예외가 나가면 Tarball 요청 자체가 깨진다. 이름만 생략한다.
  let name;
  try {
    name = decodeURIComponent(pathname.slice(1, marker));
  } catch {
    return undefined;
  }
  return name === '' ? undefined : name;
}

function createRecorder({ auditLogger, action, packageName, uplink }) {
  return function record(error, operation) {
    if (!error || isExpectedMiss(error)) {
      return;
    }
    auditLogger.recordFields({
      action,
      result: RESULTS.failure,
      reason: reasonOfError(error),
      statusCode: statusOf(error),
      packageName,
      operation,
      uplink,
    });
  };
}

// Stream 은 error 를 나중에 낸다. 소비하지 않고 듣기만 한다. Verdaccio 가 같은
// Stream 에 자기 Listener 를 붙이므로, 여기서 소비하면 본문이 사라진다.
function observeStream(stream, record, operation) {
  if (!stream || typeof stream.on !== 'function') {
    return stream;
  }
  stream.on('error', (error) => record(error, operation));
  return stream;
}

function wrapCallbackMethod(target, method, record) {
  const original = target[method];
  if (typeof original !== 'function') {
    return;
  }

  target[method] = function wrapped(...args) {
    const last = args[args.length - 1];
    if (typeof last !== 'function') {
      // Callback 이 없는 호출은 결과를 볼 수 없다. 그대로 넘긴다.
      return original.apply(this, args);
    }
    const rest = args.slice(0, -1);
    return original.apply(this, [...rest, function callbackWithAudit(error, ...values) {
      record(error, method);
      return last.call(this, error, ...values);
    }]);
  };
}

function wrapStreamMethod(target, method, record) {
  const original = target[method];
  if (typeof original !== 'function') {
    return;
  }

  target[method] = function wrapped(...args) {
    let result;
    try {
      result = original.apply(this, args);
    } catch (error) {
      record(error, method);
      throw error;
    }
    return observeStream(result, record, method);
  };
}

// 저장소 Plugin 은 Package 마다 새 객체를 돌려준다. getPackageStorage 를 감싸
// 돌려주는 객체의 메서드에 관측을 붙인다.
function observeStoragePlugin(storagePlugin, auditLogger) {
  if (!storagePlugin || typeof storagePlugin.getPackageStorage !== 'function') {
    return false;
  }

  const original = storagePlugin.getPackageStorage;
  storagePlugin.getPackageStorage = function wrapped(packageName) {
    const packageStorage = original.call(this, packageName);
    if (!packageStorage || packageStorage.__whsAudited === true) {
      return packageStorage;
    }

    const record = createRecorder({
      auditLogger,
      action: ACTIONS.storageError,
      packageName: typeof packageName === 'string' ? packageName : undefined,
    });

    for (const method of PACKAGE_CALLBACK_METHODS) {
      wrapCallbackMethod(packageStorage, method, record);
    }
    for (const method of PACKAGE_STREAM_METHODS) {
      wrapStreamMethod(packageStorage, method, record);
    }
    Object.defineProperty(packageStorage, '__whsAudited', {
      value: true,
      enumerable: false,
    });

    return packageStorage;
  };

  return true;
}

function observeUplinks(uplinks, auditLogger) {
  if (!uplinks || typeof uplinks !== 'object') {
    return 0;
  }

  let observed = 0;
  for (const [name, uplink] of Object.entries(uplinks)) {
    if (!uplink || uplink.__whsAudited === true) {
      continue;
    }

    // getRemoteMetadata(name, options, callback) 의 첫 인자가 Package 이름이다.
    // 공용 래퍼를 쓰면 이 값을 잃어, 어떤 Package 를 받다 실패했는지 알 수 없다.
    const originalGetRemoteMetadata = uplink.getRemoteMetadata;
    if (typeof originalGetRemoteMetadata === 'function') {
      uplink.getRemoteMetadata = function wrappedGetRemoteMetadata(packageName, ...rest) {
        const perCall = createRecorder({
          auditLogger,
          action: ACTIONS.uplinkError,
          uplink: name,
          packageName: typeof packageName === 'string' ? packageName : undefined,
        });
        const callback = rest[rest.length - 1];
        if (typeof callback !== 'function') {
          return originalGetRemoteMetadata.call(this, packageName, ...rest);
        }
        const head = rest.slice(0, -1);
        return originalGetRemoteMetadata.call(this, packageName, ...head, function withAudit(error, ...values) {
          perCall(error, 'getRemoteMetadata');
          return callback.call(this, error, ...values);
        });
      };
    }

    // fetchTarball 은 Package 이름을 인자로 받지 않고 URL 을 받는다. URL 에서 이름만
    // 뽑아 함께 남긴다.
    const originalFetchTarball = uplink.fetchTarball;
    if (typeof originalFetchTarball === 'function') {
      uplink.fetchTarball = function wrappedFetchTarball(url, ...rest) {
        const perCall = createRecorder({
          auditLogger,
          action: ACTIONS.uplinkError,
          uplink: name,
          packageName: packageNameFromUrl(url),
        });
        let result;
        try {
          result = originalFetchTarball.call(this, url, ...rest);
        } catch (error) {
          perCall(error, 'fetchTarball');
          throw error;
        }
        return observeStream(result, perCall, 'fetchTarball');
      };
    }

    Object.defineProperty(uplink, '__whsAudited', {
      value: true,
      enumerable: false,
    });
    observed += 1;
  }

  return observed;
}

// Verdaccio 내부 속성을 거치므로 업그레이드로 모양이 바뀔 수 있다. 바뀌면 관측을
// 켜지 못했다고 경고만 남기고 Registry 동작은 그대로 둔다.
function observeStorage({ storage, auditLogger, logger = console } = {}) {
  const storagePlugin = storage?.localStorage?.storagePlugin;
  const storageObserved = observeStoragePlugin(storagePlugin, auditLogger);
  const uplinkCount = observeUplinks(storage?.uplinks, auditLogger);

  if (!storageObserved) {
    logger.warn?.(
      { storagePlugin: storagePlugin?.constructor?.name ?? 'unknown' },
      '[verdaccio-whs-audit] storage errors are not observable; storage.error events are disabled',
    );
  }
  if (uplinkCount === 0) {
    logger.warn?.(
      { uplinks: 0 },
      '[verdaccio-whs-audit] no uplink found; uplink.error events are disabled',
    );
  }

  return { storageObserved, uplinkCount };
}

module.exports = {
  PACKAGE_CALLBACK_METHODS,
  PACKAGE_STREAM_METHODS,
  isExpectedMiss,
  observeStorage,
  observeStoragePlugin,
  observeUplinks,
  packageNameFromUrl,
  reasonOfError,
  statusOf,
};
