# Third-party license inventory

기준일: 2026-10-13
상태: 자체 라이선스와 저장소 제3자 고지 반영 완료. 공개 산출물 범위 및 최종 공개 승인은 별도다.

## 결론

- PM/PL 결정에 따라 ARGUS 자체 작성 코드는 Apache-2.0이며, 루트 `LICENSE`와 `THIRD_PARTY_NOTICES.md`를 둔다.
- Dashboard에 포함된 Wanted Sans와 IBM Plex Mono는 각각 OFL 원문을 함께 보관한다. Lucide ISC와 Feather 유래 MIT 고지 파일도 저장소에 있다.
- 실행 중인 npm 서비스의 설치 패키지에는 MIT, ISC, Apache-2.0, BSD, BlueOak, CC 계열이 포함된다. Dashboard 실행 이미지에는 `sharp`가 포함한 libvips 플랫폼 패키지 2개의 `LGPL-3.0-or-later` 선언이 확인됐다.
- npm lockfile 전체에는 실제 이미지에 선택되지 않는 다른 OS·CPU용 optional 패키지도 포함된다. 공개 저장소 고지와 Docker 이미지 배포 고지는 구분해서 검토한다.
- Scanner가 분석한 외부 package tarball, 악성 QA fixture, Provider 원문 및 비공개 QA 결과는 프로젝트 배포 산출물에 포함하지 않는다.

## 직접 production 의존성

| Component | Dependency | 확인 버전 | 선언 License |
|---|---|---:|---|
| Dashboard | better-auth | 1.7.5 | MIT |
| Dashboard | next | 16.3.6 | MIT |
| Dashboard | pg | 8.23.0 | MIT |
| Dashboard | react | 19.2.8 | MIT |
| Dashboard | react-dom | 19.2.8 | MIT |
| Gateway | @nestjs/common | 11.2.1 | MIT |
| Gateway | @nestjs/core | 11.2.1 | MIT |
| Gateway | @nestjs/platform-fastify | 11.2.1 | MIT |
| Gateway | @npmcli/arborist | 9.9.1 | ISC |
| Gateway | pg | 8.23.1 | MIT |
| Gateway | reflect-metadata | 0.2.2 | Apache-2.0 |
| Gateway | rxjs | 7.8.2 | Apache-2.0 |
| Scanner | @babel/generator | 7.29.8 | MIT |
| Scanner | @babel/parser | 7.29.8 | MIT |
| Scanner | @babel/traverse | 7.29.8 | MIT |
| Scanner | @babel/types | 7.29.8 | MIT |
| Scanner | @nestjs/common | 11.2.1 | MIT |
| Scanner | @nestjs/core | 11.2.1 | MIT |
| Scanner | @nestjs/platform-fastify | 11.2.1 | MIT |
| Scanner | npm-registry-fetch | 19.1.1 | ISC |
| Scanner | reflect-metadata | 0.2.2 | Apache-2.0 |
| Scanner | rxjs | 7.8.2 | Apache-2.0 |
| Scanner | semver | 7.8.5 | ISC |
| Scanner | ssri | 13.0.1 | ISC |
| Scanner | validate-npm-package-name | 7.0.2 | ISC |
| Scanner | webcrack | 2.16.0 | MIT |
| Scanner | zod | 4.4.3 | MIT |
| Policy | semver | 7.8.5 | ISC |
| Verdaccio storage | verdaccio-aws-s3-storage | 12.1.1 | MIT |

버전과 라이선스는 각 manifest, lockfile 및 현재 설치된 package metadata를 대조했다. 내부 Verdaccio plugin 3개는 프로젝트 코드이며 외부 npm production dependency를 선언하지 않는다.

## 실제 실행 이미지 집계

| Image / Component | 고유 package metadata | License 분포 | 확인 사항 |
|---|---:|---|---|
| Dashboard | 35 | MIT 24, Apache-2.0 5, ISC 4, LGPL-3.0-or-later 2 | LGPL 2건은 `@img/sharp-libvips-linux-x64@1.3.3`, `@img/sharp-libvips-linuxmusl-x64@1.3.3` |
| Gateway | 199 유효 패키지 | MIT 109, ISC 59, BlueOak 11, Apache-2.0 10, BSD-3-Clause 5, BSD-2-Clause 2, CC-BY-3.0 1, CC0-1.0 1, 0BSD 1 | `pino`와 `secure-json-parse` 내부 test/benchmark fixture manifest 2개는 별도 배포 dependency가 아니므로 미선언 집계에서 제외 |
| Scanner | 166 유효 패키지 | MIT 117, ISC 29, BlueOak 6, Apache-2.0 6, BSD-3-Clause 5, BSD-2-Clause 1, CC-BY-4.0 1, 0BSD 1 | 위와 같은 내부 fixture manifest 2개 제외 |
| Policy | 1 | ISC 1 | production dependency `semver@7.8.5` |

집계는 현재 로컬 실행 이미지 내부의 `package.json` name/version/license metadata를 읽었다. package 자체에 포함된 라이선스 원문·NOTICE 파일의 최종 배포 포함 여부는 이미지 산출 단계에서 별도 확인한다.

## lockfile 전체 분포

| Lockfile | production 표시 package 수 | License 분포 | 미선언 |
|---|---:|---|---:|
| `apps/dashboard/package-lock.json` | 195 | MIT 134, Apache-2.0 19, LGPL-3.0-or-later 10, MPL-2.0 12, ISC 6, BSD-2-Clause 2, BSD-3-Clause 2, MIT-0 2, 기타 결합·CC·0BSD·BlueOak 8 | 0 |
| `apps/gateway/package-lock.json` | 224 | MIT 119, ISC 62, BlueOak 22, Apache-2.0 10, BSD-3-Clause 6, BSD-2-Clause 2, CC-BY-3.0 1, CC0-1.0 1, 0BSD 1 | 0 |
| `infra/verdaccio/storage-plugins/package-lock.json` | 125 | Apache-2.0 86, MIT 31, ISC 4, BSD-3-Clause 2, Python-2.0 1, 0BSD 1 | 0 |

Dashboard lockfile에서 별도 확인이 필요한 선언은 다음과 같다.

- `@img/sharp-libvips-*`: LGPL-3.0-or-later
- `@img/sharp-*`: Apache-2.0과 LGPL-3.0-or-later 결합 선언
- `lightningcss` 및 플랫폼 패키지: MPL-2.0
- `caniuse-lite`: CC-BY-4.0
- `mdn-data`: CC0-1.0

Gateway의 `spdx-exceptions`는 CC-BY-3.0, `spdx-license-ids`는 CC0-1.0을 선언한다. Verdaccio storage lockfile의 `argparse@2.0.1`은 Python-2.0을 선언한다.

## Dashboard 자산

| 자산 | 저장소 고지 | 상태 |
|---|---|---|
| Wanted Sans | `apps/dashboard/public/fonts/Wanted-Sans-OFL.txt` | OFL 1.1 원문 포함 |
| IBM Plex Mono | `apps/dashboard/public/fonts/IBM-Plex-Mono-OFL.txt` | OFL 1.1 원문 포함 |
| Lucide/Feather 계열 아이콘 | `apps/dashboard/public/fonts/Lucide-LICENSE.txt` | Lucide ISC 및 Feather 유래 MIT copyright/license 고지 포함 |
| 기타 bitmap/image/logo | `apps/dashboard/public` 검색에서 별도 이미지 파일 미발견 | inline SVG의 제작·출처는 Dashboard 담당 최종 확인 필요 |

## Container base 및 공개 산출물

현재 Dockerfile·Compose가 직접 참조하는 외부 base는 다음과 같다.

- `node:24-alpine`
- `node:24-bookworm-slim`
- `postgres:16-alpine`
- `verdaccio/verdaccio:6.10.0`

소스 저장소 공개와 Docker image 배포는 별도 범위다. PM/PL은 아래를 최종 결정해야 한다.

1. Docker image를 실제 공개 배포할지 여부와, 공개 시 base OS 및 포함 binary의 license 원문·source offer·NOTICE 처리
2. 실험 데이터·샘플 코드·Scanner 분석 결과의 재배포 범위
3. Final SHA와 잔여 위험 수용 및 최종 공개 GO/NO-GO

## 공개 전 판정

| 항목 | 상태 |
|---|---|
| npm 직접 의존성 재고 | 완료 |
| 현재 실행 이미지 npm license metadata 집계 | 완료 |
| Dashboard 폰트·아이콘 고지 존재 확인 | 완료 |
| 프로젝트 자체 LICENSE | Apache-2.0 전문 반영 완료 |
| 저장소 제3자 고지 | `THIRD_PARTY_NOTICES.md` 반영 완료 |
| Docker 이미지 배포 범위·base OS notice | PM/PL 결정 후 확정 필요 |
| 실험 데이터·fixture 재배포 | 비공개 유지, 별도 승인 없이는 제외 |
