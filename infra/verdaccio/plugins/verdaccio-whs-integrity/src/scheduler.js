'use strict';

// 너무 짧으면 모든 npm install 이 거치는 Registry 에서 해싱이 끊이지 않는다.
const MIN_INTERVAL_SECONDS = 60;

// setInterval 은 2^31-1 ms 를 넘는 값을 받으면 1ms 로 바꿔 쉬지 않고 다시 실행한다.
const MAX_INTERVAL_SECONDS = Math.floor(2147483647 / 1000);

// 설정하지 않았거나 명시적으로 끈 경우는 경고 없이 끈다. 값이 잘못된 경우는 경고를
// 남기고 끈다. 잘못된 값을 가까운 값으로 고쳐 돌리면 운영자가 의도하지 않은 주기로
// 해싱이 돈다.
function resolveIntervalSeconds(value, logger) {
  if (value === undefined || value === null || value === false || value === 0) {
    return null;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_INTERVAL_SECONDS ||
    value > MAX_INTERVAL_SECONDS
  ) {
    safeLog(logger, 'warn',
      `[verdaccio-whs-integrity] check_interval_seconds must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}; scheduled check is disabled`,
    );
    return null;
  }

  return value;
}

function startScheduler({ intervalSeconds, runOnce, logger, timers } = {}) {
  const clock = timers ?? { setInterval, clearInterval };

  const tick = async () => {
    try {
      await runOnce();
    } catch (error) {
      // 한 번의 실패가 Timer 를 멈추거나 Process 를 죽이지 않게 한다.
      safeLog(logger, 'error', '[verdaccio-whs-integrity] scheduled check crashed', {
        err: error,
      });
    }
  };

  // 기동 직후에는 돌리지 않는다. 첫 주기가 지난 뒤 처음 실행한다. 재시작할 때마다
  // Cache 전체를 해싱하면 기동 직후 들어오는 요청이 느려진다.
  const timer = clock.setInterval(() => {
    void tick();
  }, intervalSeconds * 1000);

  // Timer 가 Verdaccio 종료를 붙잡지 않게 한다.
  timer?.unref?.();

  return {
    tick,
    stop() {
      clock.clearInterval(timer);
    },
  };
}

function safeLog(logger, level, message, payload) {
  try {
    if (payload === undefined) {
      logger?.[level]?.(message);
      return;
    }
    logger?.[level]?.(payload, message);
  } catch {
    // 로그를 남기지 못해도 검사 동작은 그대로 둔다.
  }
}

module.exports = {
  MAX_INTERVAL_SECONDS,
  MIN_INTERVAL_SECONDS,
  resolveIntervalSeconds,
  startScheduler,
};
