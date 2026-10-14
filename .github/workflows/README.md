# GitHub Actions와 보안 자동화

## PR CI

`pr-ci.yml`은 `dev` 작업 PR과 `main` 릴리스 PR에서 다음 검사를 실행합니다.

- Dashboard: lint, typecheck, unit test, build, standalone HTTP smoke
- Gateway: unit test, build
- Scanner: typecheck, unit test, build, fixture 기반 Agent CLI test
- Policy: pytest
- 통합: Compose 설정, Verdaccio approval plugin test, Policy / Decision DB smoke
- 이미지: Gateway, Scanner, Dashboard, Policy Docker build

외부 Action은 전체 커밋 SHA로 고정합니다. 새 버전은 자동으로 신뢰하지 않고
Dependabot PR의 릴리스 내용과 CI 결과를 검토한 뒤 병합합니다.

## Dependabot

`.github/dependabot.yml`은 매주 월요일 09:00 (Asia/Seoul)에 업데이트를 확인합니다.
pnpm workspace(Scanner / Policy), Gateway와 Dashboard의 npm lockfile,
Verdaccio storage plugin, Policy Python, Dockerfile, GitHub Actions를 대상으로 합니다.
Scanner의 테스트용 package.json 파일은 독립적인 업데이트 대상으로 등록하지 않습니다.

- 설정 파일은 기본 브랜치 `main`에도 반영되어야 활성화됩니다.
- 일반 버전 업데이트 PR은 `dev`를 대상으로 하며 자동 병합하지 않습니다.
- GitHub의 보안 업데이트 PR은 `target-branch`와 별개로 기본 브랜치 `main`을 대상으로 합니다.
  기존 `dev → main` 절차를 유지하려면 보안 패치를 별도 작업 브랜치에서 검증하여
  `dev`에 반영하고 릴리스합니다. 기본 브랜치 경보가 닫혔는지 확인하기 전에는
  해결된 것으로 표시하지 않습니다.
- 수정 버전이 없는 의존성이나 주요 버전 변경은 개별 이슈로 영향 범위를 검토합니다.
  경보 제거만을 위한 강제 업데이트나 자동 dismiss는 사용하지 않습니다.
- Dockerfile의 버전 ARG, Python 해시 잠금, Compose 이미지 고정 등은 이 설정만으로
  모두 관리되지 않습니다. 공급망 버전 고정이 완료됐다는 의미는 아닙니다.

## CodeQL / 브랜치 보호

CodeQL은 GitHub의 **Default setup**을 사용합니다. 중복된 CodeQL workflow를 추가하지 않습니다.
Default setup은 기본 브랜치와 보호된 브랜치의 push 및 저장소 내부 PR을 검사합니다.
따라서 `dev`도 검사하려면 GitHub에서 해당 브랜치를 보호해야 합니다.
외부 fork PR은 Default setup의 검사 범위에 포함되지 않습니다.

브랜치 보호는 저장소 설정에서 별도로 적용합니다. 필수 검사 이름은 실제 PR에
표시된 이름과 일치해야 하며, 필요한 검사가 생성되는지 확인한 뒤 필수화합니다.
팀원 승인 수와 예외 권한은 팀 합의로 결정합니다. CI나 AI 검토를 사람의 승인으로
대체하지 않습니다.

## OpenSSF Scorecard

`scorecard.yml`은 원본 저장소의 `main` push 및 매주 토요일 10:30 (Asia/Seoul)에 실행합니다.
점수는 저장소 운영 관행에 대한 지표이며, 취약점 부재나 실제 서비스의 안전성을 보증하지 않습니다.

## 참고

- [Dependabot 옵션](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)
- [CodeQL Default setup의 검사 범위](https://docs.github.com/en/code-security/concepts/code-scanning/setup-types)
