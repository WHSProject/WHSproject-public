# ARGUS 제3자 소프트웨어 고지

ARGUS 자체 작성 코드는 [Apache License 2.0](LICENSE)에 따라 제공됩니다. 아래 외부 자료는 원래 라이선스를 유지하며, ARGUS의 Apache-2.0 표기로 재라이선스되지 않습니다.

## 포함된 외부 자료

| 자료 | 출처와 적용 조건 | 사용 위치와 고지 |
|---|---|---|
| Semantic Versioning 2.0.0 권장 정규식 | Tom Preston-Werner 및 기여자, [공식 출처](https://semver.org/), [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | [Gateway tarball parser](apps/gateway/src/services/tarball-path-parser.service.ts). prerelease·build 캡처 그룹을 비캡처 그룹으로 변경했으며, 출처와 변경 설명을 코드 주석에 표시 |
| Wanted Sans | The Wanted Sans Project Authors, [공식 출처](https://github.com/wanteddev/wanted-sans), SIL OFL 1.1 | Dashboard 폰트. [저작권 및 라이선스 원문](apps/dashboard/public/fonts/Wanted-Sans-OFL.txt) |
| IBM Plex Mono | IBM Corp., [공식 출처](https://github.com/IBM/plex), SIL OFL 1.1 | Dashboard 폰트. [저작권 및 라이선스 원문](apps/dashboard/public/fonts/IBM-Plex-Mono-OFL.txt). Reserved Font Name 고지 유지 |
| Lucide | Lucide Contributors 및 Feather 유래 부분의 Cole Bemis, [공식 출처](https://lucide.dev/), ISC 및 Feather의 MIT 유래 고지 | Dashboard 코드에 포함된 SVG 아이콘. [기존 저작권 및 라이선스 고지](apps/dashboard/public/fonts/Lucide-LICENSE.txt) |

[사용자 DB 초기 마이그레이션](infra/postgres/migrations/user/001_initial.sql)의 Better Auth 테이블은 [Better Auth](https://github.com/better-auth/better-auth) CLI `auth@1.7.5 generate` 결과의 형식을 정리한 것입니다. 생성 출처와 추가 제약의 구분은 해당 파일의 주석에 명시되어 있습니다.

## 외부 도구

Tier2의 난독화 복원과 AST 분석에는 다음 설치형 라이브러리를 사용합니다. 버전은 [Scanner 의존성](apps/scanner/package.json)의 범위가 아니라 [pnpm lockfile](pnpm-lock.yaml)의 고정 버전 기준입니다.

| 자료 | 버전 및 라이선스 | 사용 목적과 고지 |
|---|---|---|
| [webcrack](https://github.com/j4k0xb/webcrack) | 2.16.0 / [MIT](https://github.com/j4k0xb/webcrack/blob/master/LICENSE) | 난독화 복원. Copyright (c) 2023 j4k0xb. 코드를 포함하는 배포물에는 원래 저작권 및 MIT 허가 고지 유지 |
| [Babel](https://github.com/babel/babel)의 `@babel/parser`, `@babel/traverse`, `@babel/types`, `@babel/generator` | 각 7.29.8 / [MIT](https://github.com/babel/babel/blob/main/LICENSE) | JavaScript AST 파싱·탐색·변환·코드 생성. 코드를 포함하는 배포물에는 각 패키지의 원래 LICENSE·저작권 고지 유지. 패키지별 저작권 표기를 단일 문구로 대체하지 않음 |

[GuardDog 3.1.0](https://github.com/DataDog/guarddog/blob/v3.1.0/LICENSE)은 Apache-2.0, [Semgrep 1.172.0](https://github.com/semgrep/semgrep/blob/v1.172.0/LICENSE)은 LGPL 2.1 라이선스 원문을 제공합니다. ARGUS의 라이선스는 이 도구들의 원래 조건을 변경하지 않습니다. 도구가 포함된 배포물에서는 원래 라이선스·저작권 및 적용되는 NOTICE를 유지합니다.

기타 설치형 라이브러리와 플러그인도 각 배포물의 라이선스를 따릅니다. 의존성 선언만 게시하는 경우와 설치된 코드를 Docker 이미지·번들에 포함해 배포하는 경우는 구분합니다.

## 패키지 레지스트리와 스토리지

| 자료 | 버전 및 라이선스 | 사용 위치와 고지 |
|---|---|---|
| [Verdaccio](https://github.com/verdaccio/verdaccio) | 공식 이미지 `verdaccio/verdaccio:6.10.0`. 본체 패키지 [6.10.0의 라이선스](https://registry.npmjs.org/verdaccio/6.10.0)는 MIT | [Dockerfile](infra/verdaccio/Dockerfile)의 npm 프록시 레지스트리. 본체의 원래 저작권·MIT 허가 고지를 유지하며, 이미지 내 다른 구성요소의 조건은 별도 유지 |
| [verdaccio-aws-s3-storage](https://github.com/verdaccio/verdaccio-aws-s3-storage) | [12.1.1 / MIT](https://registry.npmjs.org/verdaccio-aws-s3-storage/12.1.1) | [의존성 선언](infra/verdaccio/storage-plugins/package.json) 및 [lockfile](infra/verdaccio/storage-plugins/package-lock.json)로 설치하는 S3 스토리지 플러그인. 포함 배포 시 원래 저작권·MIT 허가 고지와 전이 의존성의 고지 유지 |

WHS approval·audit·integrity 플러그인은 외부 Verdaccio 본체·S3 플러그인과 구분되는 ARGUS 자체 구현입니다. 위 버전은 Dockerfile과 lockfile 기준이며, 실제 배포물에는 해당 버전에 동봉된 원문 고지를 유지합니다.

## 취약점 데이터 출처

[OSV API](https://osv.dev/)를 통한 취약점 조회는 [Scanner OSV 클라이언트](apps/scanner/src/osv/osv-feed-client.ts)에서 수행합니다. 조회 API는 `https://api.osv.dev/v1/query`이며, [공식 API 문서](https://google.github.io/osv.dev/post-v1-query/)와 [데이터 출처 및 라이선스 안내](https://google.github.io/osv.dev/data/)를 참고하세요.

OSV는 여러 원천의 취약점 정보를 제공합니다. 응답 데이터 전체를 ARGUS의 Apache-2.0이나 단일 OSV 라이선스로 취급하지 않습니다. 실제 advisory 원문·DB·Snapshot을 배포할 경우 해당 레코드의 원천 출처와 적용 조건에 따라 저작자·라이선스·변경 고지 등을 유지합니다. 예를 들어 GitHub Advisory Database 유래 데이터는 OSV의 공식 출처 목록에 CC BY 4.0으로 안내되어 있습니다. 이는 GitHub Advisory Database API를 별도로 직접 연동한다는 의미는 아닙니다.

## CI와 실행 환경

CI는 [actions/checkout](https://github.com/actions/checkout) v4, [actions/setup-node](https://github.com/actions/setup-node) v4, [actions/setup-python](https://github.com/actions/setup-python) v5, [actions/github-script](https://github.com/actions/github-script) v7, [actions/labeler](https://github.com/actions/labeler) v6를 참조합니다. 사용 위치는 [.github/workflows](.github/workflows)이며 각 Action의 원래 라이선스를 따릅니다.

실행 환경은 [Node.js 공식 이미지](https://hub.docker.com/_/node), [Python 공식 이미지](https://hub.docker.com/_/python), [PostgreSQL 공식 이미지](https://hub.docker.com/_/postgres) 및 위 Verdaccio 이미지를 사용합니다. 저장소 설정에는 Node 24 Alpine·Bookworm slim, Python 3.12 slim, PostgreSQL 16 Alpine이 지정되어 있습니다. [Compose](compose.yaml)와 각 Dockerfile을 기준으로 하며, 이미지 태그만으로 구성요소 전체의 라이선스를 단일화하지 않습니다. 빌드된 이미지를 재배포하면 기반 OS 패키지·런타임·전이 의존성을 포함한 고지 및 소스 제공 의무를 해당 조건에 따라 이행합니다.

## 평가 자료 출처

평가 자료의 출처는 [OMCBench](https://github.com/False-Positive-Community/open-malicious-code-benchmark), [Datadog 악성 패키지 데이터셋](https://github.com/DataDog/malicious-software-packages-dataset), [JsDeObsBench](https://github.com/Ch3nYe/JsDeObsBench)와 [IBM Project CodeNet](https://github.com/IBM/Project_CodeNet)입니다. 데이터셋·수집된 패키지 코드·결과에 포함된 코드 조각은 ARGUS 자체 코드의 Apache-2.0 적용 대상이 아닙니다.

이 출처 표기는 개별 자료의 재배포 허가를 대신하지 않습니다. 외부 자료에 동봉된 라이선스·저작권 고지를 유지합니다.

## 고지 적용 범위

이 문서는 직접 포함한 외부 자료와 주요 도구·서비스의 고지입니다. 전체 전이 의존성 목록이나 배포물별 라이선스 원문 묶음을 대체하지 않습니다. 라이브러리·번들·이미지를 함께 배포하는 경우 원래 저작권·라이선스·적용되는 NOTICE를 포함하고, 출처 링크만으로 원문 고지 보존을 대신하지 않습니다. ARGUS의 공식 프로젝트 출처와 자체 코드 라이선스는 [README](README.md#프로젝트-출처)와 [LICENSE](LICENSE)에 명시합니다.
