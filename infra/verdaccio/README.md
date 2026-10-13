# Verdaccio 운영 가이드

Gateway 뒤에서 npm Registry Proxy 역할을 하는 Verdaccio의 설정과 운영 절차입니다.
Verdaccio는 보안 판정을 하지 않습니다. 판정은 Policy Engine, 집행은 Gateway가 합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `config.local.yaml` | Verdaccio 설정 (로컬 저장소, 기본). 컨테이너에 read-only 마운트 |
| `config.s3.yaml` | Verdaccio 설정 (AWS S3 저장소). 저장소 블록 외에는 `config.local.yaml`과 같음 |
| `Dockerfile` | 공식 이미지에 AWS S3 Storage Plugin을 더한 이미지 |
| `storage-plugins/` | 이미지에 설치하는 Storage Plugin 목록과 lockfile (버전 고정) |
| `scripts/setup-local.ps1` | Windows 로컬 환경의 최초 계정 설정 안내 및 실행 |
| `scripts/setup-local.sh` | macOS / Linux 로컬 환경의 최초 계정 설정 안내 및 실행 |
| `scripts/bootstrap-users.sh` | 최초 1회 계정 생성 (기존 계정이 있으면 중단) |
| `scripts/manage-users.sh` | 이후 계정 추가·변경·삭제 (기존 항목 보존) |
| `scripts/verify-cache.sh` | 저장된 Tarball 과 Metadata integrity 대조 |
| `scripts/smoke.sh` | Registry 동작·권한 정책 일괄 점검 |
| `scripts/fresh-check.sh` | 빈 볼륨으로 새로 띄워 설치부터 검사까지 한 번에 확인 |
| `scripts/fresh-check.ps1` | Windows PowerShell에서 `fresh-check.sh` 실행 |
| `scripts/check-config-sync.sh` | 두 설정 파일이 저장소 설정 외에는 같은지 확인 |
| `scripts/backup-storage.sh` | Storage Volume 을 tar 로 백업 (Volume 이름 자동 탐색) |
| `scripts/restore-storage.sh` | 백업 tar 를 새 Volume 으로 복원 (소유권 자동 조정) |
| `scripts/cache-admin.sh` | Cache 목록·용량 조회와 정리 (로컬·S3 공통, 삭제는 기본 Dry-run) |
| `scripts/cache-admin.ps1` | Windows PowerShell에서 `cache-admin.sh` 실행 |
| `plugins/verdaccio-whs-approval/` | Gateway 승인 목록 수신과 Version·Tarball Guard |
| `plugins/verdaccio-whs-audit/` | 로그인·Publish·Unpublish와 Approval·Guard 보안 감사 로그 |
| `plugins/verdaccio-whs-integrity/` | 저장된 Tarball 을 해싱해 Metadata integrity 와 대조 |

Plugin 디렉터리는 `/verdaccio/plugins` 로 read-only 마운트되며, 설정 파일의
`middlewares` 키 이름으로 활성화합니다. 각 Plugin 의 설정과 동작은 해당 디렉터리의
README 를 참고합니다.

이 문서에서 `config.yaml`은 컨테이너 안의 설정 파일(`/verdaccio/conf/config.yaml`)을
말합니다. 저장소 구성에 따라 `config.local.yaml` 또는 `config.s3.yaml`이 그 자리에
마운트됩니다.

## 저장소 구성 (로컬 / AWS S3)

Package Metadata와 Tarball을 어디에 저장할지 `.env`의 값 하나로 고릅니다.

| `WHS_STORAGE_MODE` | 저장 위치 | 마운트되는 설정 | 대상 |
|---|---|---|---|
| `local` (기본, 비워 두면 이것) | Docker Volume `verdaccio_storage` | `config.local.yaml` | 사내 서버만 쓰는 조직 |
| `s3` | AWS S3 버킷 | `config.s3.yaml` | 외부 Cloud를 쓰는 조직 |

두 설정 파일은 **저장소 블록만 다르고 나머지는 같습니다.** Verdaccio는 저장소에 따라 키
구조가 달라(`storage:` ↔ `store:`) 값만 바꿔 끼울 수 없어 파일을 나눴습니다. 한쪽을 고치면
다른 쪽도 같게 고치고 다음으로 확인합니다.

```sh
sh infra/verdaccio/scripts/check-config-sync.sh
```

어느 구성이든 **계정(`htpasswd`)은 `verdaccio_storage` Volume에 남습니다.** S3 구성에서도
Volume을 지우면 계정이 사라집니다.

### S3 구성에 필요한 값

`.env`에 넣습니다. `.env.example`에는 이 값들이 주석으로 들어 있으니 필요한 줄만 주석을 풀어
채웁니다. 쓰지 않는 값은 **빈 값(`KEY=`)으로 두지 말고 줄을 지우거나 주석으로 둡니다.** S3 Plugin은 설정값에 적힌 환경변수가 비어 있으면 **변수 이름 자체를 값으로 씁니다**
(`AWS_S3_BUCKET`이 비면 버킷 이름이 `AWS_S3_BUCKET`이 됩니다). compose는 값이 없는 변수를
컨테이너에 넘기지 않지만, `.env`에 빈 값으로 적힌 변수는 빈 문자열로 넘깁니다.

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `WHS_STORAGE_MODE` | O | `s3` |
| `AWS_S3_BUCKET` | O | 버킷 이름 |
| `AWS_REGION` | O | 버킷 리전 (예: `ap-northeast-2`) |
| `AWS_ACCESS_KEY_ID` | 조건부 | IAM Role을 쓰면 넣지 않음 |
| `AWS_SECRET_ACCESS_KEY` | 조건부 | IAM Role을 쓰면 넣지 않음 |
| `AWS_ENDPOINT_URL_S3` | X | S3 호환 저장소(MinIO 등)만. AWS는 넣지 않음 |

- 리전·접속 주소·인증은 설정 파일에 적지 않고 AWS SDK가 위 표준 환경변수나 IAM Role에서
  직접 읽습니다. 값이 비었을 때 변수 이름이 들어가는 문제를 피하기 위해서입니다.
- 버킷 안에서는 `verdaccio/` 아래에 저장합니다(`keyPrefix`).
- DynamoDB는 쓰지 않습니다(`dynamoTableName: none`). Package 목록도 S3에 둡니다.
- 필요한 IAM 권한: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`
  (정기 무결성 검사의 캐시 목록 조회에 `s3:ListBucket`이 쓰입니다).
- 요청은 가상 호스트 방식(`<버킷>.<주소>`)으로 보냅니다. MinIO는 `MINIO_DOMAIN`을 설정해야
  이 방식을 받습니다.

#### AWS IAM 최소 권한 정책

다음 정책을 S3 버킷 정책이 아니라 Verdaccio가 사용하는 IAM 사용자 또는 IAM Role에
연결합니다. `<bucket-name>`은 계정·리전 접미사를 포함한 실제 버킷 전체 이름으로
바꿉니다. 권한은 해당 버킷의 `verdaccio/` Prefix로 제한합니다.
아래 JSON은 현재 기능을 실행하기 위한 기본 최소 권한 템플릿입니다. 실제 운영에서는
회사의 IAM Role, VPC Endpoint, 접근 주체 및 보안 정책에 맞춰 조건을 추가할 수 있습니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListVerdaccioStorage",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<bucket-name>",
      "Condition": {
        "StringLike": {
          "s3:prefix": [
            "verdaccio",
            "verdaccio/*"
          ]
        }
      }
    },
    {
      "Sid": "ManageVerdaccioObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::<bucket-name>/verdaccio/*"
    }
  ]
}
```

실제 Access Key와 Secret Key는 문서나 Repository에 기록하지 않습니다. AWS에서 실행하는
운영 환경에서는 장기 Access Key보다 EC2/ECS/EKS 등에 연결한 IAM Role을 우선 사용합니다.

```sh
# .env
WHS_STORAGE_MODE=s3
AWS_S3_BUCKET=<bucket>
AWS_REGION=<region>
```

바꾼 뒤에는 Verdaccio를 다시 만듭니다.

```sh
docker compose up -d --force-recreate verdaccio
```

기존 로컬 Volume에 있던 Cache는 S3로 옮겨지지 않습니다. S3 구성은 빈 저장소에서 시작하고,
필요한 Package는 다음 요청에서 npmjs로부터 다시 받아 저장합니다.

### 이미지와 S3 Plugin

공식 이미지에는 S3 Plugin이 없어 `Dockerfile`로 한 겹 더 만듭니다. 처음 `docker compose up`
때 빌드하며, 이때 npm Registry에 닿는 인터넷이 필요합니다. 로컬 구성에서는 이 Plugin을
쓰지 않으므로 공식 이미지와 똑같이 동작합니다.

| 항목 | 값 |
|---|---|
| Plugin | `verdaccio-aws-s3-storage@12.1.1` (정확한 버전 고정, `storage-plugins/package-lock.json`) |
| AWS SDK | v3 (`@aws-sdk/client-s3` 3.1014.0) |
| 설치 | `npm ci --omit=dev --ignore-scripts` (lockfile 그대로, 설치 스크립트 실행 안 함) |
| 설치 위치 | `/opt/whs-storage-plugins`. `/verdaccio/plugins`는 저장소 폴더로 덮이므로 그 밖에 둠 |

선택 근거는 다음과 같습니다.

- Verdaccio 6용 `6-next`(`11.0.0-6-next.10`)는 2022년 이후 갱신이 없고, 지원이 끝난 AWS SDK
  v2에 의존합니다. 공급망 보안 도구에 넣기에 부적합하다고 봤습니다.
- `12.1.1`은 Verdaccio 9용으로 배포됐지만 **Verdaccio 6.10.0에서 기동, 저장·조회, WHS Plugin
  3종(Approval·Guard, Integrity, Audit)이 모두 동작함을 실측으로 확인했습니다**(Smoke Test
  전 항목 통과, MinIO와 실제 AWS S3).
- Verdaccio나 이 Plugin의 버전을 올릴 때는 S3 구성으로 Smoke Test를 다시 돌립니다.

`storage-plugins/`를 바꾸면 이미지를 다시 빌드합니다.

```sh
docker compose build verdaccio
```

### S3 구성에서 달라지는 운영 도구

| 도구 | S3 구성 |
|---|---|
| `smoke.sh` | 그대로 사용. 검사 8은 Volume 대신 버킷에서 저장 여부를 확인 |
| `fresh-check.sh` | 로컬 구성만 확인 |
| `verify-cache.sh` | **사용 불가.** Volume의 파일을 직접 읽음. 무결성 검사 API(`whs-integrity`)를 씀 |
| 무결성 검사 API | 수동·정기 모두 사용. 정기 검사는 버킷에서 캐시 목록을 뽑음 |
| 백업 | Volume(계정)과 버킷을 따로 백업 |

## 처음 실행하는 사용자

GitHub에서 저장소를 처음 받은 PC에는 Verdaccio 계정이 없습니다. Docker 볼륨은
Git에 포함되지 않으므로 **PC마다 최초 한 번** 다음 절차를 실행합니다.

### 1. 프로젝트 기동

프로젝트 공통 `.env` 설정을 마친 뒤 Gateway와 Verdaccio를 기동합니다.

**먼저 `.env`의 `WHS_APPROVAL_SERVICE_TOKEN`에 무작위 값을 넣습니다.**

```sh
openssl rand -hex 32
```

Approval API는 서비스 인증이 켜져 있습니다(`config.yaml`의 `service_auth_enabled: true`).
`.env`에 값 하나만 넣으면 compose가 Gateway와 Verdaccio에 같은 값을 전달합니다. 값이
비어 있으면 일반 Registry는 기동되지만 Approval API가 모두 `401 Unauthorized`로 막혀
Gateway를 거친 설치가 실패합니다. 값을 바꾼 뒤에는 두 서비스를 함께 다시 만듭니다
(`docker compose up -d --force-recreate gateway verdaccio`). 실제 Secret은
`.env.example`이나 Repository에 기록하지 않습니다.

```powershell
docker compose up -d gateway verdaccio
```

`whs-verdaccio`가 실행 중인지 확인합니다.

```powershell
docker ps --filter "name=whs-verdaccio"
```

### 2. 최초 계정 생성 (한 줄)

Windows PowerShell:

```powershell
.\infra\verdaccio\scripts\setup-local.ps1
```

실행 정책 오류가 나면 다음 명령을 사용합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\infra\verdaccio\scripts\setup-local.ps1
```

macOS / Linux:

```sh
sh infra/verdaccio/scripts/setup-local.sh
```

두 스크립트 모두 실행 중인 Verdaccio의 실제 Docker 볼륨을 자동으로 찾습니다.
`admin` 비밀번호를 두 번 묻고, 입력 내용은 화면에 표시하지 않으며 평문
비밀번호를 파일이나 Git에 저장하지 않습니다.

| 계정 | 용도 |
|---|---|
| `admin` | 운영 작업. 무결성 검사 API, Cache 삭제, `smoke.sh` |
| `gateway-reader` | Gateway 가 Verdaccio 를 조회할 때 쓰는 읽기 전용 서비스 계정 |
| `whs-ci` | 내부 Package publish 용. 현재 흐름이 범위 밖이라 실사용 없음 |

이미 계정이 있는 Docker 볼륨이면 기존 계정을 덮어쓰지 않고 바로 종료합니다.
따라서 같은 PC에서 컨테이너를 재시작할 때마다 실행할 필요가 없습니다.

`setup-local` 스크립트는 `admin` 하나만 만듭니다. `smoke.sh` 는 `admin` 만 있으면
실행할 수 있지만, **Gateway 를 거친 설치에는 `gateway-reader` 가 반드시 필요합니다.**
없으면 Verdaccio 가 `401` 로 막는데, Verdaccio 와 Gateway 컨테이너는 정상(healthy)으로
보여 원인을 찾기 어렵습니다. 다음 단계에서 만듭니다.

### 3. Gateway 서비스 계정 생성

Gateway 가 Verdaccio 를 조회할 때 쓰는 계정을 만들고, 같은 비밀번호를 `.env` 에 넣습니다.

```sh
VERDACCIO_USER_PASSWORD='<비밀번호>' \
  sh infra/verdaccio/scripts/manage-users.sh add gateway-reader
```

```sh
# .env
VERDACCIO_SERVICE_USER=gateway-reader
VERDACCIO_SERVICE_PASSWORD=<위와 같은 비밀번호>
```

**두 값이 일치해야 합니다.** 어긋나면 Verdaccio 가 `401` 을 돌려주고 Gateway 는 설치를
실패시킵니다. `.env` 를 바꾼 뒤 Gateway 를 다시 만듭니다.

```sh
docker compose up -d --force-recreate gateway
```

처음부터 세 계정을 한 번에 만들려면 아래 「환경변수를 사용하는 수동 초기화」 절을
사용합니다. 배포 환경에서는 그 절차를 권장합니다.

`whs-ci` 는 내부 Package publish 용이며 현재 흐름이 범위 밖이라 만들지 않아도 됩니다.
`smoke.sh` 의 검사 18a·18b 를 돌릴 때만 필요합니다.

### 4. npm 로그인

**개발자는 Verdaccio 계정으로 로그인하지 않습니다.** Dashboard 에서 발급한 설치 토큰으로
Gateway 를 거쳐 설치하고, Gateway 는 Verdaccio 에 `gateway-reader` 로만 접근합니다.
발급 절차는 Dashboard 문서를 참고합니다.

아래는 운영자가 Verdaccio 를 직접 확인할 때 쓰는 절차입니다. `admin` 으로 로그인합니다.

```powershell
npm login --auth-type=legacy --registry=http://localhost:3000/npm/
```

프롬프트에 다음 값을 입력합니다.

```text
Username: admin
Password: 앞 단계에서 정한 admin 비밀번호
Email: 사용하는 이메일 주소
```

로그인 후 Gateway가 지원하는 Package Metadata 경로로 인증 상태를 확인합니다.
`npm whoami`가 사용하는 `/-/whoami` 경로는 현재 Gateway에서 노출하지 않습니다.

```powershell
npm view is-odd version --registry=http://localhost:3000/npm/
```

`is-odd`의 Version이 출력되면 로그인과 Metadata 조회가 모두 정상입니다. 로그인
토큰은 npm 설정에 저장되므로 매번 로그인할 필요는 없으며, 현재 JWT 유효기간인
7일이 지나면 다시 로그인합니다.

> `docker compose down`은 계정을 보존하지만 `docker compose down -v`는 계정이
> 들어 있는 볼륨도 삭제합니다. `-v`로 삭제한 뒤에는 최초 계정 설정을 다시
> 실행해야 합니다.

## 새 환경 설치 확인

위 절차를 처음 설치한 환경에서 따라 했을 때 정상이면 다음과 같이 보입니다.

| 단계 | 확인 방법 | 정상일 때 |
|---|---|---|
| 기동 | `docker ps --filter "name=whs-verdaccio"` | `Up ... (healthy)` |
| Plugin 로드 | `docker logs whs-verdaccio` | `plugin verdaccio-whs-audit / approval / integrity successfully loaded` 세 줄 |
| 계정 생성 | `setup-local.ps1` / `setup-local.sh` | `생성된 계정: admin` |
| 서비스 계정 | `manage-users.sh list` | `gateway-reader` 가 목록에 있음 |
| 로그인 | `npm login` | `Logged in as admin` |
| 동작 점검 | 아래 「동작 점검 (Smoke Test)」 | `통과 22 / 실패 0` |
| 무결성 검사 권한 | `POST /-/whs/integrity/checks` | 미로그인 `401`, `admin` `200`. `whs-ci` 를 만들었다면 `403` |

### 자동으로 확인하기

같은 확인을 명령 하나로 할 수 있습니다. 쓰고 있는 `whs-verdaccio`와 볼륨은 건드리지
않고, **빈 볼륨으로 Verdaccio를 따로 띄워** 확인한 뒤 모두 지웁니다.

Windows PowerShell:

```powershell
.\infra\verdaccio\scripts\fresh-check.ps1
```

macOS / Linux / Git Bash:

```sh
sh infra/verdaccio/scripts/fresh-check.sh
```

비밀번호를 묻지 않으며 따로 준비할 것이 없습니다. PowerShell용은 Git for Windows의
`sh.exe`를 찾아 `fresh-check.sh`를 실행하기만 합니다. 실행 정책 오류가 나면 위
「최초 계정 생성」과 같이 `powershell -ExecutionPolicy Bypass -File`로 실행합니다.

```text
[1] 새 환경 만들기          빈 볼륨과 Network
[2] 계정 생성               bootstrap-users.sh 로 admin, whs-ci, gateway-reader
[3] Verdaccio 기동          /-/ping 응답, WHS Plugin 3종 로드
[4] Smoke Test              smoke.sh (통과 22 / 실패 0)
[5] 무결성 검사 API 권한     401 / 403 / 200
[6] 내부 이름 Uplink 유출     @whs/* 는 npmjs 로 나가지 않음

새 환경 검증 통과 13 / 실패 0
```

이미 쓰던 환경에서는 계정·Cache·설정이 남아 있어, 새로 설치할 때만 드러나는 문제가
가려집니다. 설정이나 Plugin을 바꾼 뒤 새 설치에서도 되는지 확인할 때 씁니다.

- Docker와 npmjs에 닿는 인터넷이 필요합니다. `smoke.sh`의 검사 8·10이 실제로 Package를
  받아옵니다.
- 걸리는 시간은 1~2분입니다.
- 계정 비밀번호와 서비스 Token은 실행할 때마다 새로 만들고 화면이나 명령 인자에 남기지
  않습니다.
- 성공·실패·중단(Ctrl+C) 어느 경우에도 만든 컨테이너, 볼륨, Network를 지웁니다.
- 하나라도 실패하면 exit code 1로 끝나고 Verdaccio 로그 끝부분을 보여줍니다.
- 설정은 저장소의 `config.local.yaml`을 그대로 씁니다. 서비스 인증이나 Guard 설정을 바꾸면
  그 상태로 확인됩니다. S3 구성은 확인하지 않습니다(버킷과 인증 정보가 필요합니다).

## 환경변수를 사용하는 수동 초기화

대화형 로컬 설정 대신 운영 또는 CI 환경에서 세 계정을 한 번에 초기화할 때 사용합니다.
배포 환경에서는 이 절차를 권장합니다.

```sh
# 1. 프로젝트 기동
VERDACCIO_PUBLIC_URL=https://<gateway> docker compose up -d verdaccio

# 2. 초기 계정 생성 (admin, whs-ci, gateway-reader)
VERDACCIO_ADMIN_PASSWORD='...' VERDACCIO_CI_PASSWORD='...' \
  VERDACCIO_READER_PASSWORD='...' \
  sh infra/verdaccio/scripts/bootstrap-users.sh

# 3. 반영
docker compose restart verdaccio
```

세 비밀번호는 **계정을 만들 때만 쓰는 1회용 값**이며 `.env` 에 남기지 않습니다. 단,
`VERDACCIO_READER_PASSWORD` 는 Gateway 가 계속 읽는 `VERDACCIO_SERVICE_PASSWORD` 와
같은 값이어야 합니다.

`bootstrap-users.sh` 는 **최초 1회만** 사용합니다. 기존 `htpasswd` 에 계정이
하나라도 있으면 중단하므로 기존 계정을 덮어쓰지 않습니다. 이미 쓰고 있는 환경에
계정을 더하려면 `manage-users.sh` 를 사용합니다.

```sh
VERDACCIO_USER_PASSWORD='...' sh infra/verdaccio/scripts/manage-users.sh add gateway-reader
```

## 계정 관리

인자 없이 실행하면 대화형 메뉴에서 계정을 관리할 수 있습니다. 사용자 추가와
비밀번호 변경 시 비밀번호는 화면에 표시되지 않으며 동일한 값을 두 번 입력해야 합니다.
사용자명에는 `htpasswd` 형식을 깨뜨리는 공백과 `:`을 사용할 수 없습니다.

```sh
sh infra/verdaccio/scripts/manage-users.sh
```

```text
Verdaccio 사용자 관리
1. 사용자 목록 조회
2. 사용자 추가
3. 비밀번호 변경
4. 사용자 삭제
0. 종료
선택:
```

자동화하거나 명령을 직접 지정해야 하는 경우에는 기존 명령형 실행 방식을 사용합니다.

```sh
sh infra/verdaccio/scripts/manage-users.sh list
VERDACCIO_USER_PASSWORD='...' sh infra/verdaccio/scripts/manage-users.sh add <user>
VERDACCIO_USER_PASSWORD='...' sh infra/verdaccio/scripts/manage-users.sh passwd <user>
sh infra/verdaccio/scripts/manage-users.sh del <user>
```

반영 시점은 명령마다 다릅니다. 실측으로 확인한 내용입니다.

| 명령 | 반영 |
|---|---|
| `add` | 즉시 |
| `passwd` | 즉시 (이전 비밀번호는 바로 거부됨) |
| `del` | **재시작 필요.** 재시작 전까지 삭제된 계정으로 로그인이 계속 됨 |

```sh
docker compose restart verdaccio
```

## 계정 차단과 토큰

계정을 삭제하고 재시작해도 **그 계정이 이미 발급받은 JWT 는 만료(7일)까지 유효합니다.**
JWT 는 서명만 검증하고 계정 존재 여부를 확인하지 않기 때문입니다.

일반적인 퇴사·권한 회수는 삭제 + 재시작으로 충분하지만,
자격증명이 유출되어 **즉시 차단**해야 하는 경우에는 서명 secret 을 교체해야 합니다.

### 긴급 토큰 무효화

secret 을 교체하면 **발급된 모든 JWT 가 무효화되어 전원이 재로그인해야 합니다.**
CI 도 재로그인이 필요하므로 영향 범위를 확인하고 진행합니다.

```sh
docker compose exec verdaccio node -e '
const fs=require("fs"),crypto=require("crypto");
const p="/verdaccio/storage/data/.verdaccio-db.json";
const d=JSON.parse(fs.readFileSync(p,"utf8"));
d.secret=crypto.randomBytes(16).toString("hex");
fs.writeFileSync(p,JSON.stringify(d));
console.log("secret 교체 완료");'

docker compose restart verdaccio
```

교체 후 기존 토큰은 `401` 을 받습니다.

## 내부 Package(`@whs/*`) 지원 범위

내부 Package 는 **Verdaccio 설정까지만 구현했습니다.** Gateway 를 거친 Publish·설치는
이번 범위에서 제외했습니다.

| 구분 | 상태 |
|---|---|
| Verdaccio 권한 (`@whs/*` Publish 는 `admin`·`whs-ci`, Unpublish 는 `admin`) | 동작함. `smoke.sh` 검사 13~19 로 확인 |
| `@whs/*` 이름을 npmjs 로 조회하지 않음 | 동작함. `fresh-check.sh` 단계 6 으로 확인 |
| Gateway 를 거친 `npm publish` / `npm unpublish` | 동작하지 않음. Gateway 에 Publish·Unpublish Route 가 없음 |
| Gateway 를 거친 `npm install @whs/<pkg>` | 동작하지 않음. Gateway 분석이 npmjs 만 조회해 승인 등록이 되지 않고, Guard 가 `403` 으로 막음 |

Verdaccio 는 Host Port 를 공개하지 않으므로 Gateway 를 우회해 올릴 수도 없습니다.

`@whs/*` 권한 블록은 쓰지 않더라도 남겨 둡니다. 이 블록에 proxy 가 없어서
`@whs/*` 이름의 요청이 npmjs 로 나가지 않습니다. 블록을 지우면 `@*/*` 규칙의 proxy 를
타게 되어, npmjs 에 같은 이름으로 올라온 Package 를 받아올 수 있습니다(Dependency
Confusion).

## @whs/* Unpublish

Gateway 에 Unpublish Route 가 없어 `npm unpublish --registry=<gateway>` 는 지금
동작하지 않습니다. 내부 Package 를 지워야 하면 서버에서 `cache-admin.sh` 로 지웁니다.
Verdaccio 의 Unpublish API 를 컨테이너 안에서 `admin` 계정으로 호출합니다. 버전 단위가
아니라 Package 전체를 지웁니다.

```sh
sh infra/verdaccio/scripts/cache-admin.sh delete '@whs/<pkg>' --include-internal
sh infra/verdaccio/scripts/cache-admin.sh delete '@whs/<pkg>' --include-internal --yes
```

첫 줄은 Dry-run 으로 지울 대상만 보여 줍니다. 자세한 내용은 아래 「Cache 조회와 정리」를
참고합니다.

`whs-ci` 계정은 unpublish 권한이 없습니다(`403`). publish 만 가능합니다.

## 외부 패키지는 Unpublish 로 차단되지 않습니다

npmjs 를 proxy 하는 외부 패키지는 **캐시를 지워도 다음 요청에서 다시 받아옵니다.**
현재 권한에서는 admin 의 패키지 전체 캐시 삭제만 허용하며, 버전 단위 삭제는
publish 권한 검사에 의해 차단됩니다.

```
패키지 전체 캐시 삭제       → 로컬 Storage 데이터 제거
삭제 후 metadata/tarball 요청 → npmjs 에서 재다운로드되어 캐시 복구
```

기존 `package-lock.json` 을 가진 사용자는 metadata 를 거치지 않고 tarball URL 로
직접 요청하므로, **외부 패키지 차단은 Gateway 의 Decision 확인으로만 가능합니다.**
Verdaccio 의 unpublish 는 차단이 아니라 저장소 정리 수단입니다.

내부 `@whs/*` 는 npmjs proxy 가 없으므로 unpublish 로 실제 제거됩니다.

## 백업

`/verdaccio/storage` 볼륨 전체를 백업합니다. 포함되는 것은 다음과 같습니다.

- 내부 패키지 metadata 및 tarball
- npmjs 패키지 캐시
- `htpasswd` — **bcrypt 비밀번호 해시**
- `data/.verdaccio-db.json` — 패키지 목록 및 **토큰 서명 secret**

비밀번호 해시와 서명 secret 이 포함되므로 백업물 접근 권한을 제한해야 합니다.
`.verdaccio-db.json` 이 유실되면 secret 이 재생성되어 발급된 JWT 가 전부 무효화됩니다.

### S3 구성의 백업

S3 구성에서는 Volume 에 `htpasswd` 만 있고, Package 와 목록·서명 secret
(`verdaccio/verdaccio-s3-db.json`)은 버킷에 있습니다. 두 곳을 다르게 다룹니다.

| 대상 | 방법 | 언제 |
|---|---|---|
| 버킷 (Package, 목록, 서명 secret) | **버킷 버전 관리**를 켠다 (AWS 콘솔: 버킷 → 속성 → 버전 관리) | 한 번 설정하면 끝. 이후 S3 가 알아서 이전 버전을 보관한다 |
| 버킷 (내부 `@whs/*` 를 publish 한다면) | 위에 더해 **다른 버킷으로 복제**를 설정한다 (콘솔: 버킷 → 관리 → 복제 규칙). 가능하면 다른 계정·다른 리전 | 내부 Package 를 처음 publish 하기 전에 |
| Volume (`htpasswd`) | 아래 tar 백업 | 계정을 추가·변경·삭제한 뒤 |

버킷은 정기적으로 백업 명령을 돌리지 않아도 됩니다. 버전 관리를 켜 두면 덮어쓰기와
삭제가 실시간으로 보관되어, 마지막 백업 이후의 변경을 잃지 않습니다. 반대로 계정은
거의 바뀌지 않으므로 바뀐 뒤에 한 번 tar 로 받아 두면 충분합니다.

**버전 관리만으로는 버킷 자체가 사라지는 경우를 막지 못합니다.** 이전 버전은 같은 버킷
안에 보관되므로, 버킷을 지우거나 계정이 정지되면 함께 사라집니다. 외부 Package 캐시는
npmjs 에서 다시 받아오면 되지만, **내부 `@whs/*` 는 proxy 가 없어 이 버킷이 유일한
원본입니다.** 잃으면 되받을 곳이 없습니다.

그래서 내부 Package 를 publish 하기 시작하면 복제를 함께 설정합니다. 이는 백업이 아니라
원본을 지키는 문제입니다. 버킷 삭제 자체를 막는 설정(MFA 삭제, 버킷 정책)도 함께
검토합니다.

버킷 접근 권한도 Volume 백업물과 같은 이유로 제한합니다. 서명 secret 이 들어 있습니다.

### 백업 생성

`backup-storage.sh` 로 Storage Volume 을 tar 로 내려받습니다. 저장할 폴더만 적으면 되고,
Volume 이름은 실행 중인 컨테이너에서 찾습니다.

```sh
sh infra/verdaccio/scripts/backup-storage.sh ./backup
```

Windows PowerShell 에서 `sh` 가 없으면 Git Bash 로 실행합니다.

파일 이름에는 시각이 붙습니다(`verdaccio-storage-20260912-043644.tgz`). 만든 뒤 항목 수와
계정 파일(`htpasswd`) 포함 여부를 확인해, 빈 백업을 성공으로 넘기지 않습니다. Volume 은
읽기 전용으로만 붙으므로 실행 중인 Verdaccio 에 영향을 주지 않습니다.

직접 명령으로 하려면 다음과 같습니다. `<storage-volume>` 은 실제 Volume 이름으로 바꿉니다.

```sh
docker run --rm --user 0 \
  -v <storage-volume>:/from:ro \
  -v "$(pwd)":/out \
  --entrypoint sh verdaccio/verdaccio:6.10.0 \
  -lc 'tar czf /out/verdaccio-backup.tgz -C /from .'
```

백업물에는 비밀번호 해시와 토큰 서명 secret 이 들어 있으므로 저장 위치와 접근 권한을
제한합니다.

### 백업 자동화

`backup-storage.sh` 는 스케줄러를 포함하지 않는 수동 실행 도구입니다. 운영 환경의
스케줄러가 이 Script 또는 같은 역할의 백업 작업을 호출하도록 구성합니다. 아래 예시는
매일 03:00 실행하는 기본 템플릿이므로 실제 경로, 주기, 보관 기간은 회사 정책에 맞게
바꿉니다. 백업 폴더는 미리 만들고, 실행 계정에 Docker 및 백업 폴더 접근 권한을 줍니다.

#### Linux 서버 / Docker Compose

`crontab -e`에 다음과 같이 등록합니다. 절대 경로를 사용하고 성공/실패 로그를 별도
파일에 남깁니다.

```cron
0 3 * * * cd /srv/WHSproject && /bin/sh infra/verdaccio/scripts/backup-storage.sh /var/backups/verdaccio >> /var/log/whs-verdaccio-backup.log 2>&1
```

등록 후에는 cron을 기다리지 말고 같은 계정으로 명령을 한 번 직접 실행해 Docker 접근과
백업 파일 생성을 확인합니다.

#### Windows / Docker Desktop

Windows 작업 스케줄러에서 다음 작업을 만듭니다.

| 항목 | 값 예시 |
|---|---|
| 트리거 | 매일 03:00 |
| 프로그램 | `C:\Program Files\Git\bin\sh.exe` |
| 인수 | `-lc "cd /c/WHSproject && sh infra/verdaccio/scripts/backup-storage.sh /c/WHS-backup"` |

등록한 작업의 사용자 계정으로 Docker Desktop이 실행 중이어야 합니다. 작업 스케줄러의
**실행** 기능으로 먼저 시험하고, 마지막 실행 결과가 `0`이며 백업 파일이 생성됐는지
확인합니다.

#### Kubernetes

`backup-storage.sh` 는 Docker CLI로 실행 중인 컨테이너와 Volume을 찾으므로 Kubernetes
Pod에서는 그대로 사용하지 않습니다. Verdaccio의 PVC를 읽기 전용으로, 별도 백업 PVC를
쓰기 가능으로 마운트한 `CronJob`을 만듭니다.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: whs-verdaccio-backup
spec:
  schedule: "0 3 * * *"
  timeZone: "Asia/Seoul"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: alpine:3.22
              command: ["sh", "-c", "tar czf /backup/verdaccio-storage-$(date +%Y%m%d-%H%M%S).tgz -C /storage ."]
              volumeMounts:
                - name: storage
                  mountPath: /storage
                  readOnly: true
                - name: backup
                  mountPath: /backup
          volumes:
            - name: storage
              persistentVolumeClaim:
                claimName: <verdaccio-storage-pvc>
            - name: backup
              persistentVolumeClaim:
                claimName: <verdaccio-backup-pvc>
```

`<verdaccio-storage-pvc>`와 `<verdaccio-backup-pvc>`는 실제 PVC 이름으로 바꿉니다. 사용하는
Storage가 Volume Snapshot을 지원하면 파일 tar 대신 CSI VolumeSnapshot과 회사의 백업
정책을 우선할 수 있습니다.

#### AWS

- **EC2에서 Docker Compose로 운영:** Linux cron 예시를 사용합니다. 장기 보관이 필요하면
  EC2 Instance Role을 이용해 백업 폴더를 별도 S3 백업 Prefix로 전송하고 Lifecycle 정책으로
  보관 기간을 관리합니다. Access Key를 cron 명령에 직접 적지 않습니다.
- **ECS로 운영:** EventBridge Scheduler에서 백업용 ECS Task를 정기 실행합니다. Task는
  Verdaccio가 사용하는 EFS 등 영구 Storage를 읽기 전용으로 마운트하고 백업 결과를 S3에
  저장합니다. Docker CLI가 필요한 `backup-storage.sh`를 ECS Task에서 직접 사용하지 않습니다.
- **S3 Storage 모드:** Package Object는 버킷 버전 관리/복제 정책으로 보호하고, 이 Script는
  Volume에 남은 `htpasswd` 백업에만 사용합니다.

#### 회사 내부 스케줄러

Jenkins, GitLab CI 또는 사내 배치 시스템이 있다면 동일한 백업 명령을 예약 작업으로
등록합니다. 작업은 한 번에 하나만 실행하고, 종료 코드가 `0`이 아니면 실패로 처리해
운영 알림을 보내도록 구성합니다. 실제 백업 저장 위치, 암호화, 보관 기간, 접근 권한과
오래된 백업 삭제는 회사의 운영 정책을 따릅니다.

자동 실행을 설정한 뒤에도 주기적으로 백업 파일을 새 Volume에 복원해 실제 사용 가능한
백업인지 확인합니다. 스케줄 등록만으로 복구 가능성이 보장되지는 않습니다.

### 복구

`restore-storage.sh` 로 새 Volume 에 풉니다. 공식 Image 의 실행 사용자(UID 10001,
GID 65533)로 소유권도 맞춥니다.

```sh
sh infra/verdaccio/scripts/restore-storage.sh ./backup/verdaccio-storage-20260912-070657.tgz whs-restored
```

**쓰고 있는 Volume 은 덮어쓰지 않습니다.** 대상 Volume 이 비어 있지 않으면 멈춥니다.
복원한 Volume 으로 기동하려면 compose 의 Volume 이름을 바꾸거나, 확인용으로 임시
컨테이너에 붙입니다(Script 가 실행할 명령을 알려줍니다).

**복원 확인 결과(실측).** 계정과 Package 캐시가 있는 Volume 을 백업해 새 Volume 으로
복원하고 다음을 확인했습니다.

| 확인 | 결과 |
|---|---|
| 복원한 Volume 으로 기동 | 정상 |
| 같은 비밀번호로 로그인 | 성공, JWT 발급 |
| **복원 전에 발급한 JWT 로 조회** | `200`. 서명 secret 이 보존되어 기존 토큰이 계속 유효 |
| Package 캐시 | 그대로 복원 |
| 복원한 환경에서 `smoke.sh` | 통과 22 / 실패 0 |
| 쓰고 있는 Volume 으로 복원 시도 | 거부(exit `2`) |

직접 명령으로 하려면 다음과 같습니다.

```sh
docker run --rm --user 0 \
  -v <restore-volume>:/to \
  -v "$(pwd)":/in:ro \
  --entrypoint sh verdaccio/verdaccio:6.10.0 \
  -lc 'tar xzf /in/verdaccio-backup.tgz -C /to && chown -R 10001:65533 /to'
```

Volume 에서 Volume 으로 바로 복사하는 경우는 다음과 같습니다.

```sh
docker run --rm --user 0 \
  -v <backup-volume>:/from:ro \
  -v <restore-volume>:/to \
  --entrypoint sh verdaccio/verdaccio:6.10.0 \
  -lc 'cp -a /from/. /to/ && chown -R 10001:65533 /to'
```

복구 후에는 `/-/ping`, 기존 계정 로그인, Package Metadata/Tarball 조회를 확인합니다.
서명 secret 이 함께 복구되므로 백업 시점에 발급된 JWT 는 만료 전까지 그대로 사용할 수
있습니다.

### 소유권을 맞추지 않으면

Verdaccio 공식 Image는 UID `10001`, GID `65533`으로 실행됩니다. Storage 소유권이
이와 다르면 **기동과 읽기는 정상 동작하고 쓰기에서만 실패합니다.** 실측 결과입니다.

| 동작 | 소유권 `10001:65533` | 소유권 `root` |
|---|---|---|
| 컨테이너 기동 · Health Check | 정상 | 정상 |
| 기존 계정 로그인 | `201` | `201` |
| 기존 Package 조회 | `200` | `200` |
| 캐시에 없는 Package 요청 | `200` | `500` |

`500` 과 함께 다음 로그가 남습니다.

```text
EACCES: permission denied, mkdir '/verdaccio/storage/data/<package>'
```

복구 직후에는 정상으로 보이므로, **캐시에 없는 외부 Package 를 한 번 요청해
확인해야 합니다.** `tar` 로 백업하고 root 로 풀면 소유권이 보존되어 `chown` 없이도
동작하지만, 백업 방식에 따라 달라지므로 명령에는 항상 포함합니다.

## 동작 점검 (Smoke Test)

`smoke.sh` 는 Registry 기본 동작과 권한 정책을 한 번에 확인합니다. 기동 후,
설정을 바꾼 뒤, 그리고 Gateway 연동 이후 회귀 확인에 사용합니다.

```sh
sh infra/verdaccio/scripts/smoke.sh
```

터미널에서 실행하면 `admin` 비밀번호를 물어봅니다. 입력 내용은 화면에 표시되지
않습니다. CI 처럼 터미널이 없는 환경에서는 환경변수로 전달합니다.

```sh
VERDACCIO_ADMIN_PASSWORD='...' sh infra/verdaccio/scripts/smoke.sh
```

`admin` 계정 하나만 있으면 됩니다. `setup-local.sh` / `setup-local.ps1` 로 만든
계정을 그대로 사용할 수 있습니다.

`whs-ci` 비밀번호를 함께 주면 내부 Package 권한 검사(18a·18b)까지 돌고, 주지 않으면
그 두 항목만 건너뜁니다.

```sh
VERDACCIO_ADMIN_PASSWORD='...' VERDACCIO_CI_PASSWORD='...' \
  sh infra/verdaccio/scripts/smoke.sh
```

### 내부 Package 검사 (13~19)

검사 13~19 는 `@whs/*` 규칙이 실제로 동작하는지 확인합니다. 설정에 규칙이 적혀 있는
것과 그대로 동작하는 것은 다르기 때문입니다.

| 검사 | 확인하는 것 |
|---|---|
| 13 | 미인증 publish 차단 (`401`) |
| 14 | `admin` 의 내부 Package publish (`201`) |
| 15 | 외부 이름으로 publish 차단 (`403`, `publish: no-publish`) |
| 16 | 없는 내부 Package 는 `404`. `@whs/*` 에 proxy 가 없어 npmjs 로 이름이 나가지 않는다 |
| 17 | ACCEPT 등록 뒤 Tarball 을 받아 올린 바이트와 대조. Guard 는 내부 Package 의 Tarball 도 승인 목록 기준으로 막는다(실측) |
| 18a·18b | `whs-ci` 는 publish 가능, unpublish 는 불가 (`403`) |
| 19 | `admin` unpublish (`DELETE /{pkg}/-rev/{rev}`) 와 이후 조회 `404` |

검사용 Package 는 실행마다 다른 이름을 쓰고 검사가 끝나면 지웁니다. 저장소에 남지
않습니다. 내부 이름이 npmjs 로 나가지 않는지는 `fresh-check.sh` 의 단계 6 이 로그로
확인합니다.

검사 7 과 검사 11 의 기대값은 실행 중인 컨테이너의 실제 설정에서 읽습니다.
별도로 지정할 값은 없습니다.

| 기대값 | 읽는 곳 |
|---|---|
| Guard 활성 여부 (검사 7) | `config.yaml` 의 `whs-approval.guard_enabled` |
| Tarball URL 접두사 (검사 11) | `config.yaml` 의 `url_prefix` |
| 외부 Registry 주소 (검사 11) | Verdaccio 컨테이너의 `VERDACCIO_PUBLIC_URL` |

Script 기본값을 쓰면 설정을 바꾼 뒤 Verdaccio 는 정상인데 검사만 실패합니다. Guard 를 켠 상태로 검사하려면
`config.yaml` 을 `guard_enabled: true` 로 바꾸고 Verdaccio 를 재기동한 뒤
그대로 실행하면 됩니다.

Verdaccio 는 Host Port 를 공개하지 않으므로, 스크립트가 같은 Docker Network 안에
검사 컨테이너를 띄워 요청합니다. Storage 저장 여부 확인을 위해 Verdaccio Container의
Mount를 읽기 전용으로 공유하며, 별도 Image 나 npm CLI 는 필요 없습니다.

확인 항목은 Health Check, Web UI 차단, 가입 차단, `admin` 로그인과 JWT 발급,
ACCEPT 목록의 `400` / `200 REGISTERED`, Metadata / Tarball 준비와 Storage 저장,
ACCEPT 전 Metadata 조회 허용과 `guard_enabled` 설정에 따른 Version / Tarball
차단 동작, `dist.tarball` 접두사와 Tarball 무결성을 확인합니다.

ACCEPT 등록 직후 해당 Metadata와 Tarball 파일이 Storage에 생겼는지는 확인합니다.
다만 이후 요청이 npmjs를 다시 호출하지 않는지는 Uplink 로그를 대조해야 하므로 이
스크립트의 범위가 아닙니다. Storage 전체 Tarball의 무결성은 아래
`verify-cache.sh`가 담당합니다.

| 종료 코드 | 의미 |
| --- | --- |
| `0` | 전 항목 통과 |
| `1` | 실패 항목 있음 |
| `2` | 전제조건 미충족. 컨테이너 없음, Network 없음, 계정 미생성 |

전제조건이 `0` 이 아니라 `2` 인 이유는 `verify-cache.sh` 와 같습니다. 아무것도
검사하지 못한 상태를 통과로 읽으면 안 되기 때문입니다.

`SMOKE_PROXY_PACKAGE`에는 npmjs Metadata의 `dist.integrity`가 제공되는 외부
Package를 사용해야 합니다. 기본값 `is-odd`는 이 조건을 충족합니다.
검사 컨테이너가 ACCEPT 기대값을 만들기 위해 npmjs Metadata를 직접 조회하므로,
npmjs 접근 실패는 Registry 동작 검증 실패(`1`)로 처리합니다. Docker Network
자체가 없거나 계정이 준비되지 않은 경우는 전제조건 미충족(`2`)입니다.

내부 Package 의 Publish / Unpublish 권한은 위 검사 13~19 에서 Verdaccio 에 직접
요청해 확인합니다. Gateway 를 거친 흐름은 지원 범위 밖이라 검사하지 않습니다(「내부
Package(`@whs/*`) 지원 범위」 참고).

### 계정이 없으면 실행할 수 없습니다

`admin` 계정이 있어야 합니다. 현재 계정은 다음으로 확인합니다.

```sh
sh infra/verdaccio/scripts/manage-users.sh list
```

없으면 `setup-local.sh` / `setup-local.ps1` 로 만듭니다. 절차는 위
`처음 실행하는 사용자` 절을 참고합니다.

`whs-ci` 와 일반 사용자는 이 Script 의 검사 범위가 아닙니다. 계정별 권한 차이는
Publish / Unpublish 에서만 드러나는데 그 검사가 MVP 범위 제외이므로, 계정을 더
만들어도 검사 결과가 달라지지 않습니다.

## Cache 조회와 정리

`cache-admin.sh` 로 저장된 Package 와 용량을 보고, 필요하면 지웁니다. 저장 위치는 실행
중인 컨테이너의 설정에서 읽으므로 **로컬 구성과 S3 구성에서 같은 명령을 씁니다.**

Windows PowerShell에서는 다음처럼 실행합니다. 내부적으로 Git for Windows의 `sh.exe`를
찾아 같은 `cache-admin.sh`를 실행하므로 별도의 Cache 관리 구현은 없습니다.

```powershell
.\infra\verdaccio\scripts\cache-admin.ps1 list          # Package 목록
.\infra\verdaccio\scripts\cache-admin.ps1 usage         # 전체 용량과 용량 상위 Package
.\infra\verdaccio\scripts\cache-admin.ps1 show is-odd   # 특정 Package 상세
```

Git Bash 또는 Linux/macOS에서는 기존 Shell Script를 직접 실행합니다.

```sh
sh infra/verdaccio/scripts/cache-admin.sh list
sh infra/verdaccio/scripts/cache-admin.sh usage
sh infra/verdaccio/scripts/cache-admin.sh show is-odd
```

두 방식 모두 기본적으로 실행 중인 `whs-verdaccio` 컨테이너를 확인합니다. 다른 이름을
사용한다면 실행 전에 환경변수를 지정합니다.

```powershell
$env:VERDACCIO_CONTAINER = "my-verdaccio"
$env:VERDACCIO_ADMIN_USER = "admin"
```

```text
저장 위치: S3 (keyPrefix verdaccio/)

Package                             버전          용량  마지막 저장
is-number                            1     54.1 KB  2026-09-11T16:10:45
is-odd                               1     30.0 KB  2026-09-12T05:16:32

Package 2개, 합계 84.2 KB
```

용량에는 Tarball 과 Metadata(`package.json`)가 모두 들어갑니다. 외부 Package 의 Metadata 는
모든 Version 정보를 담고 있어 Tarball 하나보다 큰 경우가 많습니다(위 `is-odd`: Tarball
2.7KB, Metadata 24.3KB). `usage` 는 둘을 나눠서 보여줍니다.

저장 폴더나 버킷을 읽지 못하면 **빈 Cache 로 표시하지 않고 오류로 끝냅니다**(exit `1`).
권한 오류나 경로 오타를 "Cache 가 비었다" 로 읽으면 그 상태로 삭제 계획을 세우게 됩니다.

### 지우기

**기본은 Dry-run 입니다.** 무엇이 지워질지 보여주기만 하고 지우지 않습니다.

```sh
sh infra/verdaccio/scripts/cache-admin.sh delete is-odd            # 계획만 출력
sh infra/verdaccio/scripts/cache-admin.sh delete is-odd --yes      # 실제 삭제
```

Windows PowerShell에서는 다음과 같습니다.

```powershell
.\infra\verdaccio\scripts\cache-admin.ps1 delete is-odd          # Dry-run
.\infra\verdaccio\scripts\cache-admin.ps1 delete is-odd --yes    # 실제 삭제
```

PowerShell에서 `--yes`를 지정하면 admin 비밀번호를 화면에 표시하지 않고 입력받습니다.
비밀번호를 명령 인자로 적거나 파일에 저장할 필요가 없습니다.

- `--yes` 를 붙일 때만 `admin` 비밀번호를 묻습니다. 조회에는 필요 없습니다.
- **내부 Package(`@whs/*`)는 기본적으로 제외**합니다. 외부 Package 는 npmjs 에서 다시
  받아올 수 있지만 내부 Package 는 되받을 곳이 없습니다. 지우려면 `--include-internal`
  을 함께 줍니다.
- 파일을 직접 지우지 않고 Registry 의 Unpublish API(`DELETE /{package}/-rev/{rev}`)를
  씁니다. 파일만 지우면 Verdaccio 의 Package 목록과 어긋나 이후 조회가 이상해집니다.
  그래서 `unpublish: admin` 권한이 필요합니다.

내부 Package를 명시적으로 지우는 PowerShell 예시는 다음과 같습니다.

```powershell
.\infra\verdaccio\scripts\cache-admin.ps1 delete '@whs/example' --include-internal --yes
```

Scoped Package 이름은 PowerShell과 Git Bash 모두 따옴표로 감싸는 편이 안전합니다.

```sh
sh infra/verdaccio/scripts/cache-admin.sh delete '@whs/example' --include-internal --yes
```

### 다시 받아오기

지운 외부 Package 는 **다음 요청에서 npmjs 로부터 자동으로 다시 받아옵니다.** 따로
재수집 명령이 없습니다. 실측에서도 지운 뒤 조회하자 Metadata 가 다시 저장됐고, Tarball 은
그 버전을 요청할 때 다시 받았습니다.

내부 `@whs/*` 는 proxy 가 없어 다시 받아올 수 없습니다. 지우면 백업에서 복원하거나 다시
publish 해야 합니다.

## 저장 Tarball 무결성 점검

Verdaccio 는 저장한 Tarball 을 이후에 다시 검증하지 않습니다. 캐시 파일이 손상되거나
변조되어도 그대로 반환합니다. 실측으로 확인한 동작입니다.

`verify-cache.sh` 는 저장된 `.tgz` 를 직접 해싱해 Metadata 의 `dist.integrity` 와
대조합니다. 사람이 직접 실행하는 운영 도구이며 Verdaccio 동작에는 관여하지 않습니다.

Volume 의 파일을 직접 읽으므로 **로컬 저장소 구성에서만** 쓸 수 있습니다. S3 구성에서는
Volume 에 Package 가 없어 "점검 대상 없음"(exit `2`)으로 끝납니다. S3 구성에서는
`verdaccio-whs-integrity` 의 무결성 검사 API 를 씁니다.

```sh
sh infra/verdaccio/scripts/verify-cache.sh
sh infra/verdaccio/scripts/verify-cache.sh --verbose
VERDACCIO_VOLUME=<volume> sh infra/verdaccio/scripts/verify-cache.sh
```

기본 출력은 각 항목을 `[OK]`, `[FAIL]`, `[WARN]`으로 구분하고 마지막에
Package/Tarball 점검 수량과 최종 결과를 남깁니다.

| 상태 | 의미 |
|---|---|
| `[OK]` | Metadata를 읽었거나 Tarball Hash가 기준값과 일치 |
| `[FAIL]` | Tarball의 `integrity` 또는 `shasum`이 기준값과 불일치 |
| `[WARN]` | Metadata 오류, 참조 Hash 누락, 대상 없음 등으로 검증 불가 |

정상 실행 예시는 다음과 같습니다.

```text
Verdaccio cache verification
Volume: whsproject_verdaccio_storage
Storage: /verdaccio/storage/data

[OK] Package is-odd metadata
[OK] Tarball is-odd@3.0.1 integrity

Summary
Package checks: 1
Tarball checks: 1
OK: 2
FAIL: 0
WARN: 0
Result: PASS
```

불일치와 검증 불가 항목은 기본 출력에서도 Package, Version, 파일명과 원인을
보여줍니다. 상세 경로, 사용한 알고리즘, 기준 Hash와 실제 Hash는 `--verbose`에서
확인합니다.

```text
Verdaccio cache verification
Volume: whsproject_verdaccio_storage
Storage: /verdaccio/storage/data
Mode: verbose

[OK] Package is-odd metadata
  stage: metadata-read
  metadata: /verdaccio/storage/data/is-odd/package.json
  versions: <all cached versions>
[FAIL] Tarball is-odd@3.0.1
  stage: tarball-integrity
  file: /verdaccio/storage/data/is-odd/is-odd-3.0.1.tgz
  diagnostic: INTEGRITY_MISMATCH
  reason: integrity mismatch
  algorithm: sha512
  expected: sha512-abc...
  actual: sha512-xyz...

Summary
Package checks: 1
Tarball checks: 1
OK: 1
FAIL: 1
WARN: 0
Result: FAIL
```

| 종료 코드 | 의미 |
|---|---|
| `0` | 검사 완료. 전부 일치 |
| `1` | 불일치, 검증 불가, Metadata 오류 중 하나 이상 존재 |
| `2` | 점검 대상이 없음. Volume 이름과 Storage 경로를 확인 |

`0` 과 `2` 를 나눈 이유는 Volume 이름을 잘못 지정했을 때를 성공으로 넘기지 않기 위해서입니다.
`docker run` 은 없는 Volume 이름을 받으면 빈 Volume 을 새로 만들기 때문에, 스크립트가
실행 전에 `docker volume inspect` 로 존재 여부를 먼저 확인합니다.

`integrity` 가 없는 구버전 Package 는 `shasum`(sha1) 으로 대조합니다.

스크립트는 Storage Volume을 read-only로 마운트하고 표준 출력과 종료 코드만
제공합니다. Cache를 수정·삭제·복구하거나 Gateway 및 외부 시스템으로 결과를
전송하지 않습니다. 점검 결과와 경고는 stdout으로 출력하며 자동화에서는 종료
코드 `0/1/2`를 최종 판정 기준으로 사용합니다. 잘못된 CLI 사용법은 stderr로
출력합니다.

### 확인하는 범위

현재 저장된 Tarball 이 같은 저장소의 Metadata `dist.integrity` 와 일치하는지만
확인합니다. 다음은 **확인하지 못합니다.**

- 백업 전에 있던 Tarball 이 복구 후 누락되었는지
  사라진 파일은 검사 목록에 나타나지 않습니다
- 계정(`htpasswd`) 과 토큰 서명 secret 이 복구되었는지
- Metadata 까지 함께 변조된 경우
  비교 기준이 같은 저장소 안에 있으므로 서로 일치하면 정상으로 판단합니다

따라서 이 스크립트만으로 백업 복구가 완전하다고 판단할 수 없습니다. 복구 검증은
`/-/ping`, 기존 계정 로그인, Package Metadata/Tarball 조회를 함께 확인해야 합니다.

스크립트는 검사만 하며 불일치 항목을 자동으로 삭제하지 않습니다.

외부 Package 는 운영자가 손상된 Cache 를 삭제하면 다음 요청에서 npmjs 로부터 다시
받아옵니다. 내부 `@whs/*` Package 는 npmjs proxy 가 없어 다시 받아올 곳이 없으므로,
정상 백업에서 복구하거나 관리 절차에 따라 다시 배포해야 합니다.

여러 알고리즘의 integrity 가 함께 있으면 가장 강한 것(`sha512` > `sha384` > `sha256`)
하나로만 검증합니다. 약한 알고리즘이 일치해도 강한 쪽이 어긋나면 불일치로 처리합니다.

## 손상된 Metadata 는 프로세스를 종료시킵니다

Metadata 의 `dist.tarball` 에 URL 로 파싱되지 않는 값이 저장되면, 이후 **그 Package 의
Metadata 를 조회하는 순간 Verdaccio 프로세스가 종료됩니다.** 실측 결과입니다.

- Publish 시점에는 `dist.tarball` 값을 검증하지 않고 `201` 로 수용합니다
- 이후 해당 Package 조회에서 다음 로그와 함께 프로세스가 종료됩니다

```text
"err":{"type":"TypeError","message":"Invalid URL",
  "stack":"TypeError: Invalid URL\n    at new URL (...)\n    at Module.extractTarballFromUrl ..."}
```

문제가 저장되는 시점(Publish)과 드러나는 시점(조회)이 분리되어 있어 원인을 찾기
어렵습니다. Compose 의 `restart` 정책으로 컨테이너가 다시 떠도 **손상된 Metadata 는
Volume 에 남아 있으므로**(실측), 같은 Package 를 다시 조회하면 같은 지점에서 종료됩니다.

`verify-cache.sh` 는 이 유형을 잡지 못합니다. Tarball 해시를 대조하는 도구이며
`dist.tarball` 이 URL 로 유효한지는 확인하지 않습니다.

### 복구

해당 Package 의 Storage 를 삭제하고 재시작합니다. 실측으로 확인한 절차입니다.

```sh
docker run --rm --user 0 -v <storage-volume>:/s \
  --entrypoint sh verdaccio/verdaccio:6.10.0 \
  -lc 'rm -rf "/s/data/@whs/<pkg>"'

docker compose restart verdaccio
```

외부 Package 라면 다음 요청에서 npmjs 로부터 다시 받아옵니다. 내부 `@whs/*` 는
정상 백업에서 복구하거나 다시 배포해야 합니다.

### 예방

`@whs/*` 의 Publish 는 `admin` 과 `whs-ci` 로 제한되어 있으므로, 이 두 계정의 Publish
경로(CI 파이프라인 포함)가 만드는 `dist.tarball` 값이 유효한 URL 인지가 관건입니다.
잘못된 값 하나가 해당 Package 조회를 통해 Registry 전체 가용성에 영향을 줍니다.

## npmjs 장애 시 동작

실측으로 확인한 내용입니다. Uplink 재시도 값은 이 결과를 근거로 정했습니다.

### 장애 유형과 무관하게 404 로 수렴합니다

npmjs 쪽 실패는 대부분 `no such package available` 로 반환됩니다. Verdaccio 가
Uplink 실패를 "이 Package 는 여기 없다" 로 해석하기 때문이며 설정으로 바꿀 수 없습니다.

| upstream 상황 | Verdaccio 응답 |
|---|---|
| 진짜 없는 Package | `404` |
| upstream `500` / `503` | `404` |
| 깨진 JSON 응답 | `404` |
| 연결 거부 (ECONNREFUSED) | `404` |
| DNS 실패 | `404` |
| 패킷 유실로 응답 없음 | `503` (Uplink timeout 도달 시) |

즉 **"Package 가 없다" 와 "npmjs 가 죽었다" 를 응답만으로 구분할 수 없습니다.**

로그에는 원인이 남습니다. 응답 직전에 `ERR` 줄이 있으면 장애입니다.

```text
"msg":"ERR, req: 'GET https://registry.npmjs.org/is-number', error: getaddrinfo EAI_AGAIN"
"msg":"404, user: admin, req: 'GET /is-number', error: no such package available"
```

Gateway 는 npmjs 를 직접 조회하므로 자기 조회 결과와 대조해 판별할 수 있습니다.

### Cache 된 Package 는 계속 제공됩니다

npmjs 에 닿지 못해도 이미 받아둔 Package 는 `200` 으로 응답합니다. Metadata 갱신에
실패하면 stale Cache 를 그대로 내보냅니다. **장애 중에도 기존 Package 설치는 됩니다.**

단, `maxage` 가 만료된 Metadata 는 갱신을 먼저 시도하므로 Uplink 가 차단되기 전까지
응답이 지연됩니다. 차단된 뒤에는 다시 빨라집니다.

### max_fails 와 fail_timeout

실패가 `max_fails` 에 도달하면 Uplink 를 차단하고 `fail_timeout` 동안 유지합니다.
차단된 뒤에는 upstream 을 시도하지 않으므로 오히려 응답이 빨라집니다.

```text
1~5회차   404   5,000ms 대     실패 누적
6회차     404      74ms        Uplink 차단됨
```

`fail_timeout` 이 지나면 자동으로 재시도합니다. `5m` 에서는 npmjs 가 복구되어도
재시작 전까지 `404` 가 이어졌고, `1m` 으로 낮춘 뒤에는 약 40초에 자동 복구됐습니다.

### Storage 오류

Storage 오류는 두 가지가 다르게 나타납니다. 실측 결과입니다.

| 상황 | 응답 | 설치 | 드러남 |
|---|---|---|---|
| 소유권 불일치 | `500` | 실패 | 바로 보임 |
| 디스크 가득 참 | `200` | 성공 | 로그에만 남음 |

**소유권 불일치**는 `500 internal server error` 와 함께 다음 로그가 남습니다.

```text
EACCES: permission denied, mkdir '/verdaccio/storage/data/<package>'
```

npmjs 장애의 `404` 와 구분됩니다. 자세한 내용은 백업 절의
`소유권을 맞추지 않으면` 을 참고하세요.

**디스크 가득 참**은 Tarball 저장에 실패해도 Client 에는 정상 전달됩니다.
3MB Storage 에 5MB Tarball 을 요청했을 때 `200` 과 함께 5,242,880 bytes 를
모두 수신했습니다. 잘린 파일은 남지 않고 정리되므로 손상된 Cache 가 생기지는
않습니다.

다만 Cache 에 저장되지 않아 매 요청마다 npmjs 를 다시 호출합니다.

```text
1회차  200  127ms  5,242,880 bytes
2회차  200   94ms  5,242,880 bytes
3회차  200  114ms  5,242,880 bytes
```

**응답이 정상이라 증상이 드러나지 않습니다.** 사용자는 설치에 성공하고 상태
코드만 보는 모니터링에도 잡히지 않습니다. 로그의 `ENOSPC` 로만 확인됩니다.

```text
"code":"ENOSPC"
"msg":"error saving file { url: 'https://registry.npmjs.org/...' }"
```

Cache 적중률이 떨어지고 npmjs 트래픽이 늘어나는 형태로 나타나므로, Storage
사용량을 함께 확인해야 합니다.

## 알아두어야 할 설정 특성

실측으로 확인한 내용입니다. 설정 변경 시 참고하세요.

- `config.yaml` 은 **환경변수 치환을 지원하지 않습니다.** `${VAR}` 를 쓰면 기동에 실패합니다
- Web UI 비활성화 키는 `web.enable` 입니다. 이미지 기본 config 주석의 `enabled` 는 무시됩니다
- `VERDACCIO_STORAGE_PATH` 환경변수는 동작하지 않습니다. 저장 경로는 `storage:` 키가 결정합니다
- S3 Plugin 은 `store.aws-s3-storage` 의 값이 환경변수 이름이면 그 값을 읽지만, 변수가 비어
  있으면 **이름 글자를 그대로 값으로 씁니다.** `${VAR}` 치환과는 다른 이 Plugin 만의 방식입니다
- `userRateLimit` 은 **인증 API 전용**이며 **IP 기준**입니다. 패키지 요청에는 적용되지 않습니다
- `max_users: -1` 이면 로그인 API(`PUT /-/user/org.couchdb.user:<id>`)가 가입 요청으로
  먼저 판정됩니다. **JSON 본문만 보내면 기존 계정이 비밀번호를 맞게 보내도
  `409 user registration disabled` 로 끊깁니다.** `Authorization: Basic` 을 함께
  보내야 `201` 과 JWT 를 돌려줍니다. npm CLI 는 이 헤더를 같이 보내므로
  `npm login` 으로는 드러나지 않습니다. Gateway 가 인증 요청을 전달할 때
  이 헤더를 보존해야 합니다
- `url_prefix` 는 tarball URL 생성에만 관여하며 라우팅은 바꾸지 않습니다.
  Gateway 가 `/npm` 을 제거하고 전달해야 합니다
- uplink 동시 요청 수를 제한하는 설정은 없습니다. `agent_options.maxSockets` 는 적용되지 않습니다
