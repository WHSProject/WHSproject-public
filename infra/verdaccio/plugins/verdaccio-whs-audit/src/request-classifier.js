'use strict';

const { ACTIONS } = require('./audit-event');

// npm login 이 보내는 사용자 문서 이름의 접두사.
const LOGIN_DOC_PREFIX = 'org.couchdb.user:';

// 감사 대상 요청만 골라낸다. 대상이 아니면 undefined 를 돌려주고, 그 요청에는
// 아무 Listener 도 붙이지 않는다.
//
// 정상 Metadata 조회와 Tarball 다운로드는 대상이 아니다. npm install 한 번에 수백 건이
// 발생해 감사 로그가 묻힌다. 그 이력은 기존 Access Log 로 확인한다.
function classifyRequest(request) {
  const method = request?.method;
  if (typeof method !== 'string') {
    return undefined;
  }

  const segments = readSegments(request);
  if (segments === undefined || segments.length === 0) {
    return undefined;
  }

  if (segments[0] === '-') {
    return classifyInternalPath(method, segments);
  }

  return classifyPackagePath(method, segments);
}

// 사용자 문서에 대한 쓰기 요청을 로그인 시도로 본다.
//
//   PUT /-/user/{doc}             npm CLI 의 로그인. Basic Header 를 함께 보내면
//                                 기존 계정 인증으로 처리되어 201 과 Token 을 받는다
//                                 (infra/verdaccio/scripts/smoke.sh 실측 주석)
//   PUT /-/user/{doc}/-rev/{rev}  Basic 없이 시작한 흐름에서 Token 을 받는 단계
//
// 두 경로 모두 자격 증명이 오가는 지점이라 함께 기록한다. Basic 없이 보내면 계정과
// 비밀번호가 맞아도 409 로 끝나므로, 한 번의 로그인에서 실패와 성공이 잇달아 남을 수
// 있다. 상태 코드로 구분한다.
//
// GET /-/user/{doc} 은 _rev 를 읽는 조회라 대상이 아니다.
function classifyInternalPath(method, segments) {
  if (method !== 'PUT' || segments[1] !== 'user') {
    return undefined;
  }

  const isUserDocument = segments.length === 3;
  const isUserDocumentRevision = segments.length === 5 && segments[3] === '-rev';

  if (!isUserDocument && !isUserDocumentRevision) {
    return undefined;
  }

  return { action: ACTIONS.login, actor: readLoginActor(segments[2]) };
}

// Publish 와 Unpublish 는 쓰기 Method 로만 들어온다. 같은 경로의 GET/HEAD 는
// 조회이므로 대상이 아니다.
//
//   PUT    /{pkg}                        Publish
//   PUT    /{pkg}/-rev/{rev}             Version 단위 Unpublish 의 Metadata 수정
//   DELETE /{pkg}/-rev/{rev}             Package 전체 삭제
//   DELETE /{pkg}/-/{file}/-rev/{rev}    Tarball 삭제
function classifyPackagePath(method, segments) {
  if (method !== 'PUT' && method !== 'DELETE') {
    return undefined;
  }

  const target = readPackageName(segments);
  if (target === undefined) {
    return undefined;
  }

  const rest = segments.slice(target.consumedSegments);

  if (method === 'PUT') {
    if (rest.length === 0) {
      return { action: ACTIONS.publish, packageName: target.packageName };
    }

    if (rest.length === 2 && rest[0] === '-rev') {
      return { action: ACTIONS.unpublish, packageName: target.packageName };
    }

    return undefined;
  }

  if (rest.length === 2 && rest[0] === '-rev') {
    return { action: ACTIONS.unpublish, packageName: target.packageName };
  }

  if (rest.length === 4 && rest[0] === '-' && rest[2] === '-rev') {
    return { action: ACTIONS.unpublish, packageName: target.packageName };
  }

  return undefined;
}

function readLoginActor(userDocument) {
  if (!userDocument.startsWith(LOGIN_DOC_PREFIX)) {
    return undefined;
  }

  const name = userDocument.slice(LOGIN_DOC_PREFIX.length);

  return name === '' ? undefined : name;
}

// Scoped Package 는 `/@scope/name` 과 `/@scope%2Fname` 두 형태로 들어온다.
function readPackageName(segments) {
  const first = segments[0];

  if (!first.startsWith('@')) {
    return { packageName: first, consumedSegments: 1 };
  }

  if (first.includes('/')) {
    const [scope, name, ...rest] = first.split('/');
    if (scope === '@' || scope === '' || name === undefined || name === '' || rest.length > 0) {
      return undefined;
    }

    return { packageName: `${scope}/${name}`, consumedSegments: 1 };
  }

  if (segments.length < 2 || segments[1] === '' || segments[1] === '-') {
    return undefined;
  }

  return { packageName: `${first}/${segments[1]}`, consumedSegments: 2 };
}

function readSegments(request) {
  const pathname = getPathname(request);
  const raw = pathname.split('/').filter(Boolean);

  try {
    return raw.map((segment) => decodeURIComponent(segment));
  } catch {
    // 잘못된 Encoding 때문에 Registry 요청을 막지 않는다. 감사 대상에서만 뺀다.
    return undefined;
  }
}

function getPathname(request) {
  if (typeof request.path === 'string') {
    return request.path;
  }

  const url = request.originalUrl ?? request.url ?? '';

  return String(url).split('?')[0];
}

module.exports = {
  classifyRequest,
  readPackageName,
};
