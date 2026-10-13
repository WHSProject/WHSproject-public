'use strict';

// Gateway Contract 협의 전까지 사용하는 잠정 기본값이다.
// 최종 기본값과 최대값은 Gateway와 협의 후 확정한다.
const DEFAULT_TTL_SECONDS = 3600;

// Date 가 표현할 수 있는 시각을 넘기면 toISOString 이 RangeError 를 던진다.
// 등록 시각을 더해도 안전하도록 여유를 둔 상한이며, 정책상의 최대 TTL 이 아니다.
const MAX_TTL_SECONDS = 8_000_000_000_000;

class ApprovalConflictError extends Error {
  constructor(message, artifact) {
    super(message);
    this.name = 'ApprovalConflictError';
    this.packageName = artifact?.packageName;
    this.version = artifact?.version;
  }
}

class ApprovalStore {
  constructor({
    ttlSeconds = DEFAULT_TTL_SECONDS,
    now = Date.now,
    onExpired,
  } = {}) {
    this.artifacts = new Map();
    this.ttlSeconds = ttlSeconds;
    this.now = now;
    this.onExpired = onExpired;
  }

  register(packages) {
    // 한 요청으로 등록되는 Approval 이 서로 다른 만료 시각을 갖지 않도록
    // 기준 시각은 한 번만 읽는다.
    const registeredAtMs = this.now();

    // 새 승인이 계속 들어오는 동안 오래된 항목이 쌓이지 않도록 먼저 걷어낸다.
    // 조회되지 않는 Package 의 만료 승인은 이 시점에 정리된다.
    this.purgeExpired(registeredAtMs);

    // 마지막 관문이다. 여기부터 저장까지 await 이 없어야 두 요청이 각자 검사를
    // 통과한 뒤 서로 다른 integrity 를 함께 남기는 일이 생기지 않는다.
    const conflict = this.findIntegrityConflict(packages, registeredAtMs);
    if (conflict !== undefined) {
      throw new ApprovalConflictError(conflictMessage(conflict), conflict.artifact);
    }

    const registeredAt = new Date(registeredAtMs).toISOString();
    const expiresAt = new Date(
      registeredAtMs + this.ttlSeconds * 1000,
    ).toISOString();

    for (const artifact of packages) {
      this.artifacts.set(
        ApprovalStore.keyOf(artifact),
        Object.freeze({ ...artifact, registeredAt, expiresAt }),
      );
    }
  }

  has(artifact) {
    const key = ApprovalStore.keyOf(artifact);
    const stored = this.artifacts.get(key);
    if (stored === undefined) {
      return false;
    }

    const nowMs = this.now();
    if (isExpired(stored, nowMs)) {
      this.removeExpired(key, stored, nowMs);
      return false;
    }

    return true;
  }

  findByPackage(packageName) {
    return this.collectActive(
      (artifact) => artifact.packageName === packageName,
    );
  }

  findByTarball(packageName, filename) {
    return this.collectActive(
      (artifact) =>
        artifact.packageName === packageName && artifact.filename === filename,
    );
  }

  listActive() {
    this.purgeExpired();
    return [...this.artifacts.values()];
  }

  revokeByPackageVersion(packageName, version) {
    const nowMs = this.now();
    this.purgeExpired(nowMs);

    let revokedCount = 0;
    for (const [key, artifact] of this.artifacts) {
      if (artifact.packageName === packageName && artifact.version === version) {
        this.artifacts.delete(key);
        revokedCount += 1;
      }
    }

    return revokedCount;
  }

  get size() {
    this.purgeExpired();
    return this.artifacts.size;
  }

  // 조건에 맞는 Approval 중 유효한 것만 돌려주고, 그 과정에서 만난 만료 Approval 은
  // 지운다. 별도 Scheduler 없이 조회 시점에 정리하는 방식이다.
  // 신규 Artifact 들이 서로, 그리고 기존 활성 Approval 과 충돌하는지 본다.
  // 첫 충돌을 돌려주고 충돌이 없으면 undefined 를 돌려준다.
  findIntegrityConflict(artifacts, nowMs = this.now()) {
    const requested = new Map();

    for (const artifact of artifacts) {
      const key = conflictKeyOf(artifact);

      // ① 같은 요청 안에서의 충돌. 기존 승인이 하나도 없어도 걸러야 한다.
      const sameRequest = requested.get(key);
      if (
        sameRequest !== undefined &&
        sameRequest.integrity !== artifact.integrity
      ) {
        return { artifact, conflictsWith: sameRequest };
      }
      requested.set(key, artifact);

      // ② 기존 활성 Approval 과의 충돌. 만료된 항목은 여기서 정리되고 제외된다.
      const stored = this.collectActive(
        (entry) => conflictKeyOf(entry) === key,
        nowMs,
      );
      const mismatched = stored.find(
        (entry) => entry.integrity !== artifact.integrity,
      );
      if (mismatched !== undefined) {
        return { artifact, conflictsWith: mismatched };
      }
    }

    return undefined;
  }

  // 한 번의 조회 안에서 기준 시각이 흔들리지 않도록 현재 시각은 한 번만 읽는다.
  collectActive(matches, nowMs = this.now()) {
    const active = [];

    for (const [key, artifact] of this.artifacts) {
      if (!matches(artifact)) {
        continue;
      }

      if (isExpired(artifact, nowMs)) {
        this.removeExpired(key, artifact, nowMs);
        continue;
      }

      active.push(artifact);
    }

    return active;
  }

  purgeExpired(nowMs = this.now()) {
    for (const [key, artifact] of this.artifacts) {
      if (isExpired(artifact, nowMs)) {
        this.removeExpired(key, artifact, nowMs);
      }
    }
  }

  // 실제 삭제에 성공한 항목만 한 번 알린다. Callback 실패는 Store 동작에 영향을
  // 주지 않으며, clear()처럼 TTL 만료가 아닌 삭제에는 호출하지 않는다.
  removeExpired(key, artifact, nowMs) {
    // Callback은 순회 중 Store를 변경하지 않는 내부 알림으로 사용한다.
    if (!this.artifacts.delete(key)) {
      return;
    }

    try {
      this.onExpired?.(artifact, nowMs);
    } catch {
      // Audit 실패 때문에 만료된 Approval 이 다시 유효해져서는 안 된다.
    }
  }

  clear() {
    this.artifacts.clear();
  }

  static keyOf({ packageName, version, integrity }) {
    return JSON.stringify([packageName, version, integrity]);
  }
}

// Tarball 요청 경로에는 Version 이 없어 Guard 가 packageName + filename 으로만
// 승인을 찾는다. 같은 파일에 서로 다른 integrity 가 함께 남으면 어느 쪽 기준으로
// 통과했는지 알 수 없으므로, 이 조합을 승인 목록에 들이지 않는다.
function conflictKeyOf({ packageName, filename }) {
  return JSON.stringify([packageName, filename]);
}

// integrity 전체 값은 진단에 필요하지 않아 남기지 않는다.
function conflictMessage({ artifact, conflictsWith }) {
  return (
    `conflicting integrity for tarball: ${artifact.packageName}/${artifact.filename}` +
    ` (${artifact.version} does not match the approved ${conflictsWith.version})`
  );
}

// Store 없이 신규 Artifact 들 사이의 충돌만 본다.
function findConflictingIntegrity(artifacts) {
  const requested = new Map();

  for (const artifact of artifacts) {
    const key = conflictKeyOf(artifact);
    const sameRequest = requested.get(key);

    if (
      sameRequest !== undefined &&
      sameRequest.integrity !== artifact.integrity
    ) {
      return { artifact, conflictsWith: sameRequest };
    }

    requested.set(key, artifact);
  }

  return undefined;
}

// 만료 시각과 같은 순간부터 만료로 본다. 승인이 유효한 구간은 expiresAt 직전까지다.
//
// expiresAt 을 읽을 수 없는 Approval 도 만료로 취급한다. register 를 거치면 항상
// 채워지므로 정상 경로에서는 나오지 않지만, 시각을 잃은 승인이 무기한 유효해지는
// 쪽보다 차단되는 쪽이 안전하다.
function isExpired(artifact, nowMs) {
  const expiresAtMs = Date.parse(artifact?.expiresAt);

  return Number.isNaN(expiresAtMs) || expiresAtMs <= nowMs;
}

// 잘못된 설정을 조용히 통과시키면 의도치 않게 무기한에 가까운 Approval 이 된다.
// 값을 버리고 기본값으로 되돌리되, 어떤 값이 무시됐는지 로그로 남긴다.
function resolveTtlSeconds(value, logger) {
  if (value === undefined || value === null) {
    return DEFAULT_TTL_SECONDS;
  }

  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_TTL_SECONDS
  ) {
    logger?.warn?.(
      { configuredTtlSeconds: value, appliedTtlSeconds: DEFAULT_TTL_SECONDS },
      '[verdaccio-whs-approval] invalid approval_ttl_seconds; applied the default',
    );
    return DEFAULT_TTL_SECONDS;
  }

  return value;
}

module.exports = {
  ApprovalConflictError,
  ApprovalStore,
  conflictMessage,
  findConflictingIntegrity,
  isExpired,
  resolveTtlSeconds,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
};
