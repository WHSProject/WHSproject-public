# 협업 규칙

## Issue 규칙

작업은 Issue로 먼저 등록합니다.

제목 예시:

```text
[Frontend] 로그인 화면 구현
[Backend] 로그인 API 구현
[DB] 사용자 테이블 설계
[Docs] README 수정
```

## Branch 규칙

```text
main
develop
feature/기능명
```

개인 작업은 항상 `feature/*` 브랜치에서 진행합니다.

## Pull Request 규칙

- PR은 `develop` 브랜치로 보냅니다.
- 최소 1명 이상 리뷰 후 병합합니다.
- 충돌이 있으면 PR 작성자가 해결합니다.

## Code Review 규칙

- 동작 오류가 있는지 확인합니다.
- 변수명과 함수명이 이해하기 쉬운지 확인합니다.
- 불필요한 코드가 없는지 확인합니다.
- 실행 방법이나 API가 바뀌면 문서도 같이 수정했는지 확인합니다.

## main 브랜치 보호 추천 설정

GitHub `Settings > Branches`에서 설정합니다.

- 직접 push 금지
- Pull Request 필수
- 최소 1명 review 필수
- 가능하면 테스트 통과 필수

