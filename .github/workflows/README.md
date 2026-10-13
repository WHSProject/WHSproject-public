# GitHub Actions

이 디렉터리에서는 WHSProject의 CI / 통합 테스트 관련
GitHub Actions Workflow를 관리합니다.

각 Component의 다음 정보가 확정된 후 Workflow를 추가합니다.

- Runtime
- Build Command
- Test Command
- Dockerfile
- 통합 실행 방법

추후 다음과 같은 Workflow를 구성할 예정입니다.

```text
PR Check
→ Build / Test
→ Docker Build
→ Integration Test
→ E2E Test