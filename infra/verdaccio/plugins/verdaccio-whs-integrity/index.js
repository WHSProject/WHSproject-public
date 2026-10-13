'use strict';

const {
  DEFAULT_ALLOWED_USERS,
  authorizeAdmin,
  resolveAllowedUsers,
} = require('./src/admin-auth');
const {
  CacheListingUnavailableError,
  canListCachedPackages,
  describeStoragePlugin,
  listCachedTargets,
  selectCacheLister,
} = require('./src/cache-targets');
const {
  CheckRequestError,
  validateCheckRequest,
} = require('./src/check-request');
const {
  CheckBusyError,
  createCheckRunner,
  summarize,
  summaryLevel,
} = require('./src/check-runner');
const {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  resolveIntervalSeconds,
  startScheduler,
} = require('./src/scheduler');
const {
  REASON,
  STATUS,
  isSafePackageName,
  verifyTarball,
} = require('./src/verify-tarball');
const {
  ALGORITHM_STRENGTH,
  SUPPORTED_ALGORITHMS,
  formatSri,
  hashStream,
  parseSri,
  selectStrongest,
} = require('./src/sri');

const LOG_PREFIX = '[verdaccio-whs-integrity]';

class WhsIntegrityMiddleware {
  constructor(config = {}, options = {}) {
    this.endpoint = config.endpoint;
    this.logger = options.logger ?? console;
    this.allowedUsers = resolveAllowedUsers(config.allowed_users, this.logger);
    this.intervalSeconds = resolveIntervalSeconds(
      config.check_interval_seconds,
      this.logger,
    );
    // Test 에서 해싱과 Timer 를 대신할 수 있게 둔다. 운영에서는 둘 다 기본값이다.
    this.verify = options.verify ?? verifyTarball;
    this.timers = options.timers;
  }

  register_middlewares(app, _auth, storage) {
    // 수동 검사와 정기 검사가 같은 실행 상태를 쓴다. 겹치면 같은 Tarball 을 두 번
    // 해싱하게 된다.
    this.runner = createCheckRunner({ storage, verify: this.verify });

    if (this.endpoint) {
      app.post(this.endpoint, (request, response) =>
        this.handleCheck(request, response),
      );
    } else {
      safeLog(this.logger, 'warn', undefined,
        `${LOG_PREFIX} endpoint is not configured; integrity check API is disabled`,
      );
    }

    this.startScheduledCheck(storage);
  }

  startScheduledCheck(storage) {
    if (this.intervalSeconds === null) {
      return;
    }

    // 이 저장소에서 캐시 목록을 뽑는 방법이 없으면 정기 검사만 끈다. 일부만 검사하고
    // 정상처럼 보고하지 않기 위함이다. 수동 검사와 Registry 는 그대로 동작한다.
    const lister = selectCacheLister(storage);
    if (lister === undefined) {
      safeLog(this.logger, 'warn', { storagePlugin: describeStoragePlugin(storage) },
        `${LOG_PREFIX} storage plugin cannot list cached packages; scheduled check is disabled`,
      );
      return;
    }

    this.scheduler = startScheduler({
      intervalSeconds: this.intervalSeconds,
      runOnce: () => this.runScheduledCheck(storage),
      logger: this.logger,
      timers: this.timers,
    });
    safeLog(this.logger, 'info',
      { intervalSeconds: this.intervalSeconds, cacheLister: lister.name },
      `${LOG_PREFIX} scheduled check enabled`,
    );
  }

  async runScheduledCheck(storage) {
    // 수동 검사가 돌고 있으면 목록을 뽑는 비용도 들이지 않고 건너뛴다.
    if (this.runner.isRunning()) {
      safeLog(this.logger, 'info', { source: 'scheduled' },
        `${LOG_PREFIX} scheduled check skipped; another check is running`,
      );
      return;
    }

    safeLog(this.logger, 'info', { source: 'scheduled' },
      `${LOG_PREFIX} scheduled check started`,
    );

    let listing;
    try {
      listing = await listCachedTargets(storage);
    } catch (error) {
      safeLog(this.logger, 'error', { source: 'scheduled', err: error },
        `${LOG_PREFIX} failed to list cached packages`,
      );
      return;
    }

    let results;
    try {
      results = await this.runner.run(listing.targets);
    } catch (error) {
      // 목록을 뽑는 사이 수동 검사가 시작될 수 있다.
      if (error instanceof CheckBusyError) {
        safeLog(this.logger, 'info', { source: 'scheduled' },
          `${LOG_PREFIX} scheduled check skipped; another check is running`,
        );
        return;
      }

      safeLog(this.logger, 'error', { source: 'scheduled', err: error },
        `${LOG_PREFIX} scheduled check failed`,
      );
      return;
    }

    const summary = summarize(results);
    safeLog(this.logger, summaryLevel(summary), {
      source: 'scheduled',
      packages: listing.packages,
      unreadablePackages: listing.unreadable,
      skippedPackages: listing.skipped,
      ...summary,
    }, `${LOG_PREFIX} scheduled check finished`);

    this.logProblems(results, { source: 'scheduled' });
  }

  // 결과를 저장하는 곳이 없어 건수만 남기면 어느 Package 가 문제인지 알 수 없다.
  // PASS 가 아닌 항목만 한 줄씩 남긴다. 이름·버전·상태·사유만 담고 Hash 와 detail 은
  // 남기지 않는다. detail 에는 Storage 오류 메시지가 그대로 들어올 수 있다.
  logProblems(results, context) {
    for (const result of results) {
      if (result?.status === STATUS.pass) {
        continue;
      }

      safeLog(this.logger, 'warn', {
        ...context,
        status: result?.status,
        packageName: result?.packageName,
        version: result?.version,
        reason: result?.reason,
      }, `${LOG_PREFIX} integrity check problem`);
    }
  }

  async handleCheck(request, response) {
    // 권한부터 본다. 거부된 요청이 본문을 읽거나 Storage 를 건드리지 않게 한다.
    const auth = authorizeAdmin(request, this.allowedUsers);
    if (auth.status !== 200) {
      // 계정 이름만 남긴다. JWT 와 Authorization Header 는 남기지 않는다.
      safeLog(this.logger, 'warn',
        { user: auth.name, statusCode: auth.status },
        `${LOG_PREFIX} rejected integrity check request`,
      );
      response.status(auth.status).json({ error: auth.error });
      return;
    }

    let targets;
    try {
      targets = validateCheckRequest(await readJsonBody(request));
    } catch (error) {
      if (error instanceof CheckRequestError) {
        safeLog(this.logger, 'warn',
          { user: auth.name, reason: error.message },
          `${LOG_PREFIX} rejected invalid integrity check request`,
        );
        response.status(400).json({ error: error.message });
        return;
      }

      safeLog(this.logger, 'error', { user: auth.name, err: error },
        `${LOG_PREFIX} failed to read integrity check request`,
      );
      response.status(500).json({ error: 'internal plugin error' });
      return;
    }

    let results;
    try {
      results = await this.runner.run(targets);
    } catch (error) {
      if (error instanceof CheckBusyError) {
        safeLog(this.logger, 'warn', { user: auth.name },
          `${LOG_PREFIX} integrity check is already running`,
        );
        response.status(409).json({ error: error.message });
        return;
      }

      safeLog(this.logger, 'error', { user: auth.name, err: error },
        `${LOG_PREFIX} integrity check failed`,
      );
      response.status(500).json({ error: 'internal plugin error' });
      return;
    }

    const summary = summarize(results);
    safeLog(this.logger, summaryLevel(summary),
      { user: auth.name, source: 'manual', ...summary },
      `${LOG_PREFIX} integrity check finished`,
    );
    // 응답은 요청한 관리자만 본다. 나중에 로그만으로도 무엇이 문제였는지 알 수 있게
    // 정기 검사와 같은 형식으로 남긴다.
    this.logProblems(results, { user: auth.name, source: 'manual' });
    response.status(200).json({
      status: 'COMPLETED',
      count: results.length,
      results,
    });
  }
}

async function readJsonBody(request) {
  if (request.body !== undefined) {
    return request.body;
  }

  let rawBody = '';
  for await (const chunk of request) {
    rawBody += chunk;
  }

  if (rawBody.trim() === '') {
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new CheckRequestError('request body must contain valid JSON');
  }
}

function safeLog(logger, level, payload, message) {
  try {
    if (payload === undefined) {
      logger?.[level]?.(message);
      return;
    }
    logger?.[level]?.(payload, message);
  } catch {
    // 운영 로그 실패가 검사 응답을 바꾸지 않게 한다.
  }
}

function createWhsIntegrityMiddleware(config, options) {
  return new WhsIntegrityMiddleware(config, options);
}

module.exports = createWhsIntegrityMiddleware;
module.exports.WhsIntegrityMiddleware = WhsIntegrityMiddleware;
module.exports.DEFAULT_ALLOWED_USERS = DEFAULT_ALLOWED_USERS;
module.exports.authorizeAdmin = authorizeAdmin;
module.exports.resolveAllowedUsers = resolveAllowedUsers;
module.exports.CheckRequestError = CheckRequestError;
module.exports.validateCheckRequest = validateCheckRequest;
module.exports.CheckBusyError = CheckBusyError;
module.exports.createCheckRunner = createCheckRunner;
module.exports.summarize = summarize;
module.exports.summaryLevel = summaryLevel;
module.exports.CacheListingUnavailableError = CacheListingUnavailableError;
module.exports.canListCachedPackages = canListCachedPackages;
module.exports.describeStoragePlugin = describeStoragePlugin;
module.exports.selectCacheLister = selectCacheLister;
module.exports.listCachedTargets = listCachedTargets;
module.exports.MAX_INTERVAL_SECONDS = MAX_INTERVAL_SECONDS;
module.exports.MIN_INTERVAL_SECONDS = MIN_INTERVAL_SECONDS;
module.exports.resolveIntervalSeconds = resolveIntervalSeconds;
module.exports.startScheduler = startScheduler;
module.exports.ALGORITHM_STRENGTH = ALGORITHM_STRENGTH;
module.exports.REASON = REASON;
module.exports.STATUS = STATUS;
module.exports.SUPPORTED_ALGORITHMS = SUPPORTED_ALGORITHMS;
module.exports.formatSri = formatSri;
module.exports.hashStream = hashStream;
module.exports.isSafePackageName = isSafePackageName;
module.exports.parseSri = parseSri;
module.exports.selectStrongest = selectStrongest;
module.exports.verifyTarball = verifyTarball;
