# 공개 범위·라이선스 결정 인계

상태: 자체 라이선스·공식 출처·제3자 고지 문안 확정, 나머지 공개 게이트 대기, Public HOLD. 사용자에게 제안했던 Discord 공지는 미발송으로 기록한다.

| 항목 | 확인 근거 | 남은 결정 |
|---|---|---|
| 공개 대상 | PM 회신상 main 예정, dev→main PR Workflow | Final SHA·병합·Visibility 승인 |
| 자체 라이선스 | PM/PL이 ARGUS 자체 작성 코드를 Apache-2.0으로 확정, 루트 `LICENSE` 반영 | Final SHA에서 파일 포함 여부 재확인 |
| 공식 출처 | PM/PL 확정 문안으로 README에 KISA 주관 화이트햇스쿨 4기 프로젝트 결과물 표기 | Final SHA에서 문안 재확인 |
| 직접 포함한 외부 코드 | Gateway SemVer 출처 보완 Issue513/PR514 완료 | 나머지 파트 취합 결과 및 필요한 고지 확정 |
| CI/배포/QA source | GitHub Actions·Compose·Dockerfile·QA script, QA PR516 준비 | 직접 복사·수정 자료 출처 취합 확인 |
| 일반 의존성·Dashboard 자산 | `THIRD_PARTY_NOTICES.md` 및 기존 폰트·아이콘 원문 반영, `docs/third-party-license-inventory.md`에서 직접 의존성·lockfile·실행 이미지 metadata 확인 | 실제 공개 Docker image/binary가 있다면 배포물별 원문·NOTICE 묶음 확인 |
| Docker image·배포 산출물 | 로컬 build/QA 수행, 이미지 registry Push 없음. base image 및 실제 npm runtime license 집계 | 소스 공개 외 image/binary 공개 여부와 base OS/binary 고지 방식 |
| 4개 악성 fixture/raw QA 결과 | 소유자 QA 사용 동의, Git 제외 비공개 보존 | 공개 대상에서 제외, 재배포 동의로 간주하지 않음 |
| 기존 실험 데이터/샘플 | PM 보고상 일부 조건 확인 필요 | 각 소유자의 공개/재배포 범위 확정 |
| 인증 설정 | .env/.npmrc Git 제외, 실제 값 문서화 없음 | Reviewer 로컬 주입 및 screenshot/log 비노출 |

PM 결정 기록: 2026-10-13 전달 문안에 따라 자체 코드는 Apache-2.0, 공식 출처는 KISA 주관 화이트햇스쿨 4기 팀 프로젝트 결과물, 제3자 고지는 루트 `THIRD_PARTY_NOTICES.md`로 확정했다. 외부 자료는 원래 조건을 유지하며 미확정 샘플은 공개 범위에서 제외한다. 공개 source Final SHA, image/binary 공개 여부, 잔여 위험 수용 및 최종 GO/NO-GO는 아직 확정 대상이다.

GitHub read-only 확인: PR515 merged, PR516 Draft. 라이선스 결정은 PM/PL의 2026-10-13 전달 내용을 기준으로 이 QA 브랜치에 반영한다. 이 반영만으로 공개 승인을 뜻하지 않는다.
