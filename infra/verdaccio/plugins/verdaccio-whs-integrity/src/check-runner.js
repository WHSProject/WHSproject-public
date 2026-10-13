'use strict';

const { STATUS, verifyTarball } = require('./verify-tarball');

class CheckBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CheckBusyError';
  }
}

// 수동 검사와 정기 검사가 같은 실행 상태를 공유한다. 이미 검사 중이면 새 실행을
// 시작하지 않고 알린다. 같은 Tarball 을 두 번 해싱하지 않기 위함이다.
function createCheckRunner({ storage, verify = verifyTarball } = {}) {
  let running = false;

  return {
    isRunning() {
      return running;
    },

    async run(targets) {
      if (running) {
        throw new CheckBusyError('integrity check already running');
      }

      running = true;
      try {
        const results = [];
        // 한 번에 하나씩 해싱한다. 모든 npm install 이 거치는 Registry 와 같은
        // Process 라, 여러 Tarball 을 동시에 읽으면 정상 요청이 느려진다.
        for (const target of targets) {
          results.push(await verify(storage, target));
        }
        return results;
      } finally {
        // 성공·실패·예외 어느 쪽이든 풀어야 다음 검사가 영원히 막히지 않는다.
        running = false;
      }
    },
  };
}

// 운영 로그에는 건수만 남긴다. 기대값·실제값 Hash 는 응답에만 담는다.
function summarize(results) {
  const summary = { total: results.length, pass: 0, fail: 0, unverifiable: 0 };

  for (const result of results) {
    if (result?.status === STATUS.pass) {
      summary.pass += 1;
    } else if (result?.status === STATUS.fail) {
      summary.fail += 1;
    } else {
      summary.unverifiable += 1;
    }
  }

  return summary;
}

// 문제가 하나라도 있으면 요약도 warn 으로 올린다. audit Plugin 이 실패를 warn 으로
// 남기는 것과 같은 기준이다. warn 이상만 보는 운영에서도 전체 몇 개 중 몇 개가
// 문제였는지 함께 보인다.
function summaryLevel(summary) {
  return summary.fail > 0 || summary.unverifiable > 0 ? 'warn' : 'info';
}

module.exports = {
  CheckBusyError,
  createCheckRunner,
  summarize,
  summaryLevel,
};
